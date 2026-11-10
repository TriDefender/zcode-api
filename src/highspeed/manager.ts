/**
 * HighSpeed 加速卡管理 — mirrors ZCode 3.15.1 `HighspeedCardService`
 * (host chunk-3JWYEFTD `wo`; transport `Ar` = createHighspeedHttpTransport).
 *
 * 官方语义（`_reverse/NOTEPAD.md` §C）：
 * - 每条消息提交时尝试 `POST {origin}/api/v1/highspeed/draw`（1s 预算）；
 *   命中获得限时加速卡（mock `expires_at = now + 3e5` ≈ 5min）。
 * - 单卡槽：持卡期间不再抽；卡绑 task_id（官方=会话/任务）。
 * - 鉴权（`Js` buildHighspeedCodingPlanAuthHeaders，与 MCP relay 同配方）：
 *   Authorization: Bearer <zcode JWT> + X-Bigmodel-Authorization: Bearer <coding-plan
 *   token> + Bigmodel-Target-Type。2026-10-10 实弹：API-key 配方同样过 auth 层。
 *
 * 反代偏差（deliberate deviations，官方为"每消息内联尝试、miss 尊重 next_draw_at"）：
 * - 抽卡为后台最大速率循环：首个合格请求同步点燃（当拍即发第一次 draw），
 *   此后按心跳节拍（≈1s，实测服务端令牌桶容量 8/回填 1/s——即真实最大可持续
 *   速率，更快只会换来 429→5s 退避）持续重试；miss（card=null）**忽略服务端
 *   next_draw_at**，下一个心跳立即重试（2026-10-12 用户决策：抽卡窗口价值在
 *   请求活跃期，等 2min 冷却等于放弃加速）。
 * - 空闲自熄：最后一次合格请求 5min 后循环停止；新请求重新点燃。
 * - task_id 复用 client-session affinity 推断（`upstreamSessionId`），无会话时
 *   每次抽卡用随机 UUID；持卡窗口内所有合格请求共享该卡（官方仅卡所属任务）。
 * - 503/biz 3404（账号未灰度，2026-10-10 实弹稳态）负缓存 10min，避免 12.6s
 *   级联延迟反复触发；429 退避 5s（2026-10-14 实测校准：可持续上限 ≈1/s，偶发
 *   429 只值秒级暂停）；传输失败退避 60s。心跳定时器 unref——
 *   永不自持进程（对齐 update-check 惯例，#58 的 docker-stop 教训）。
 */
import { randomUUID } from "node:crypto";
import type { UpstreamHeaderPair } from "../proxy/upstream.js";
import type { Credential } from "../auth/types.js";
import { credentialString } from "../auth/types.js";
import { warmHighspeedProviderConfig } from "./provider-config.js";

const DRAW_PATH = "/api/v1/highspeed/draw";
/** Measured admitted-draw tail reaches ~5.6s (2026-10-14 probe); official transport timeout is 20s. */
const DRAW_TIMEOUT_MS = 10_000;
/** Heartbeat cadence of the draw loop ≈ measured token-bucket refill (1/s). */
const DRAW_RETRY_MS = 1_000;
/** Stop drawing this long after the last eligible request (idle self-extinguish). */
const IDLE_MS = 5 * 60_000;
/** Negative cache after account-level unavailability (503 / biz 3404). */
const UNAVAILABLE_MS = 10 * 60_000;
/**
 * Backoff after an HTTP 429 (2026-10-14 live probe: the sustainable ceiling is
 * ≈1 draw/s and even ~1/s trips sporadic 429s; the bucket refills at ~1s
 * level, so a long pause only burns draw chances during active traffic).
 */
const RATE_LIMIT_BACKOFF_MS = 5_000;
/** Cooldown after transport failure (network / timeout). */
const TRANSPORT_FAILURE_MS = 60_000;
/** Skip applying a card with less than this left on its window. */
const CARD_MIN_REMAINING_MS = 10_000;

export interface HighspeedCard {
  cardId: string;
  taskId: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
}

export interface HighspeedAuth {
  /** zcode plan JWT (`Credential.jwt`) — required for both draw and card headers. */
  jwt: string;
  /** Coding-plan credential string for X-Bigmodel-Authorization. */
  codingPlanAuth: string;
  /** Provider family of the active coding plan. */
  family: "zai" | "bigmodel";
}

interface DrawResponseBody {
  code?: unknown;
  msg?: unknown;
  data?: { card?: DrawCardWire | null };
}

interface DrawCardWire {
  card_id?: unknown;
  task_id?: unknown;
  provider?: unknown;
  model?: unknown;
  issued_at?: unknown;
  expires_at?: unknown;
}

interface LatestDrawRequest {
  model: string;
  taskId: string;
  auth: HighspeedAuth;
}

export class HighspeedManager {
  private readonly origin: string;
  private readonly models: string[];
  private readonly deviceMid: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Heartbeat interval — production default 1s; tests inject small values. */
  private readonly retryMs: number;
  private readonly notedKeys = new Set<string>();
  onEvent?: (message: string) => void;

  private card: HighspeedCard | null = null;
  private unavailableUntil = 0;
  /**
   * Models the draw endpoint rejected at parameter level (live 2026-10-14:
   * `glm-5.3-flash` → HTTP 400 biz 3001 "parameter error" while `glm-5.3`
   * passes on the same account). Per-model, deliberately NOT the account-level
   * negative cache — a rejected model must not silence draws for the rest of
   * the catalogue.
   */
  private readonly drawBlockedUntil = new Map<string, number>();
  /** Earliest next draw attempt (429 / transport backoff gate). */
  private nextAttemptAt = 0;
  /** Loop deadline = last eligible request + IDLE_MS. */
  private loopUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drawInFlight: Promise<void> | null = null;
  /** Most recent eligible request — the loop always draws with these params. */
  private latest: LatestDrawRequest | null = null;

  constructor(opts: {
    origin: string;
    models: string[];
    /** Injected as X-Device-Mid (deliberate deviation, activity compatibility).
     * Historical 3001 observations also included unsupported models (flash);
     * the code alone does not establish that device identity is missing. */
    deviceMid?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    retryMs?: number;
    onEvent?: (message: string) => void;
  }) {
    this.origin = opts.origin.replace(/\/+$/u, "");
    this.models = opts.models.map((m) => m.trim().toLowerCase()).filter(Boolean);
    this.deviceMid = opts.deviceMid?.trim() || undefined;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? DRAW_RETRY_MS;
    this.onEvent = opts.onEvent;
    liveManagers.add(this);
  }

  /** Prefix match against the configured eligible families (glm-5.3/5.2/5.1 …). */
  isEligibleModel(model: string | undefined): boolean {
    if (!model) return false;
    const m = model.trim().toLowerCase();
    return this.models.some((prefix) => m === prefix || m.startsWith(`${prefix}-`));
  }

  /**
   * Fire-and-forget draw trigger — call on every eligible coding-plan request.
   * Stamps the idle window with the latest request params and (re)ignites the
   * background loop. While a card is held nothing is drawn (single slot);
   * concurrent draws deduplicate into one in-flight request.
   */
  onRequest(model: string, sessionTaskId: string | undefined, auth: HighspeedAuth): void {
    if (!this.isEligibleModel(model)) return;
    const now = this.now();
    // draw 端点参数级拒绝的模型不再点燃（每次 TTL 窗口省一次 400 探测）
    const blockedUntil = this.drawBlockedUntil.get(model.trim().toLowerCase());
    if (blockedUntil !== undefined) {
      if (now < blockedUntil) return;
      this.drawBlockedUntil.delete(model.trim().toLowerCase());
    }
    this.expireCard(now);
    // Refresh latest before the held-card early return below: the process-wide
    // manager outlives proxy restarts and credential switches, so a held card
    // drawn by the previous account can be rejected (401/3402) by the new
    // account's request — and dropCard() re-ignites the loop from `latest`,
    // which must then carry the current account's auth or the redraw burns the
    // old account's token.
    this.latest = { model, taskId: sessionTaskId ?? randomUUID(), auth };
    // Held-card traffic is still activity: rejection must be able to redraw
    // within five minutes of this request, not only of the original draw.
    this.loopUntil = now + IDLE_MS;
    // an unusable card (< CARD_MIN_REMAINING_MS) must not block re-ignition —
    // requests during those last seconds go out uncarded anyway, and holding
    // the slot would stall the loop until full expiry
    if (this.card && this.card.expiresAt - now >= CARD_MIN_REMAINING_MS) return;
    this.ensureLoop();
  }

  /**
   * In-flight request activity (an SSE response still producing): extend the
   * idle window WITHOUT re-stamping model/auth params — a stream that has
   * been generating for minutes is not "idle", so a turn that ends inside
   * the window must not let the draw loop idle-stop right after it (NOTEPAD
   * "3.16.3 增补" §H). Fires at stream end: a stream longer than IDLE_MS
   * still lets tick() stop the loop mid-flight. Never ignites a stopped
   * loop; the next real request does that via onRequest.
   */
  noteActivity(): void {
    this.loopUntil = this.now() + IDLE_MS;
  }

  /** The active card, or null when outside the window (expiry-checked). */
  activeCard(): HighspeedCard | null {
    this.expireCard(this.now());
    if (!this.card) return null;
    if (this.card.expiresAt - this.now() < CARD_MIN_REMAINING_MS) return null;
    return this.card;
  }

  /**
   * Inference URL carded requests reroute to (`highspeedLlmUrl` of this
   * manager's origin — the same plane that serves /draw).
   */
  get llmUrl(): string {
    return highspeedLlmUrl(this.origin);
  }

  /**
   * Active card usable for THIS request model. A card carries the model it was
   * drawn for and mounting rewrites the request to card.model — so a flash
   * request must never take a non-flash card (that would silently change the
   * model tier; the draw endpoint rejects flash outright, live 2026-10-14).
   */
  activeCardFor(model: string): HighspeedCard | null {
    const card = this.activeCard();
    if (!card) return null;
    const flash = (m: string): boolean => m.toLowerCase().includes("flash");
    return flash(model) === flash(card.model) ? card : null;
  }

  /** Drop the card after an upstream rejection (401 / biz 3402) — bounded proxy fallback (official selectionFallback also handles general failures). */
  dropCard(reason: string): void {
    if (!this.card) return;
    this.card = null;
    this.onEvent?.(`highspeed: card dropped (${reason})`);
    // Mid-idle-window restart: while the session is still active a replacement
    // card is redrawn immediately (first draw fires synchronously).
    if (this.now() < this.loopUntil) this.ensureLoop();
  }

  /** Stop the draw loop (shutdown / manager recreation). Idempotent, no-throw. */
  stop(): void {
    this.stopTimer();
  }

  private expireCard(now: number): void {
    if (this.card && this.card.expiresAt <= now) {
      this.onEvent?.(`highspeed: card ${this.card.cardId} expired`);
      this.card = null;
    }
  }

  /** Ignite the loop if it is not running. First draw fires synchronously. */
  private ensureLoop(): void {
    if (this.timer) return;
    const latest = this.latest;
    if (!latest) return;
    if (!latest.auth.jwt.trim()) {
      this.noteOnce("no-jwt", "credential has no zcode JWT — highspeed disabled until re-login");
      return;
    }
    if (this.drawInFlight) {
      // In-flight draw with a stopped timer (idle-stop raced a request):
      // re-arm the heartbeat; tick() applies the gates.
      this.arm();
      return;
    }
    void this.tick();
  }

  /** One loop beat: gate checks, maybe draw, re-arm. */
  private tick(): void {
    const now = this.now();
    this.expireCard(now);
    // same sub-min-remaining rule as onRequest: an unusable card must not
    // stop the loop — the replacement draw fires while the old one winds down
    if (this.card && this.card.expiresAt - now >= CARD_MIN_REMAINING_MS) {
      this.stopTimer();
      return;
    }
    if (now >= this.loopUntil) {
      this.stopTimer();
      this.onEvent?.("highspeed: draw loop idle-stopped (5min without eligible requests)");
      return;
    }
    if (this.drawInFlight || now < this.nextAttemptAt || now < this.unavailableUntil) {
      this.arm();
      return;
    }
    const latest = this.latest;
    if (!latest || !latest.auth.jwt.trim()) {
      this.stopTimer();
      return;
    }
    // 同 onRequest 的模型闸：被 draw 端点参数级拒绝的模型不再发 fetch，
    // 空转等 latest 换模型（新请求）或空闲窗口关闭（idle-stop）。
    const latestBlockedUntil = this.drawBlockedUntil.get(latest.model.trim().toLowerCase());
    if (latestBlockedUntil !== undefined) {
      if (this.now() < latestBlockedUntil) {
        this.arm();
        return;
      }
      this.drawBlockedUntil.delete(latest.model.trim().toLowerCase());
    }
    const promise = this.draw(latest.model, latest.taskId, latest.auth)
      .catch(() => {
        // draw() never throws (all outcomes map to backoff windows); network
        // throws land here as an extra guard.
        this.nextAttemptAt = this.now() + TRANSPORT_FAILURE_MS;
      })
      .finally(() => {
        if (this.drawInFlight === promise) this.drawInFlight = null;
      });
    this.drawInFlight = promise;
    this.arm();
  }

  /** Re-arm the heartbeat. unref'd: the loop never keeps the process alive. */
  private arm(): void {
    this.stopTimer();
    const timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, this.retryMs);
    timer.unref?.();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async draw(model: string, taskId: string, auth: HighspeedAuth): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAW_TIMEOUT_MS);
    let status = 0;
    let body: DrawResponseBody | null = null;
    try {
      const resp = await this.fetchImpl(`${this.origin}${DRAW_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": auth.jwt.startsWith("Bearer ") ? auth.jwt : `Bearer ${auth.jwt}`,
          "X-Bigmodel-Authorization": `Bearer ${auth.codingPlanAuth}`,
          "Bigmodel-Target-Type": "PERSONAL",
          "x-request-id": randomUUID(),
          ...(this.deviceMid ? { "X-Device-Mid": this.deviceMid } : {}),
        },
        body: JSON.stringify({
          task_id: taskId,
          provider: `builtin:${auth.family}-coding-plan`,
          model,
        }),
        redirect: "manual",
        signal: controller.signal,
      });
      status = resp.status;
      try {
        body = await resp.json() as DrawResponseBody;
      } catch {
        body = null;
      }
    } catch {
      this.nextAttemptAt = this.now() + TRANSPORT_FAILURE_MS;
      this.noteOnce("transport", "highspeed draw failed (network/timeout) — retrying later");
      return;
    } finally {
      clearTimeout(timer);
    }

    const now = this.now();
    const wireCode = typeof body?.code === "number" ? body.code : null;
    const wireMsg = typeof body?.msg === "string" ? body.msg.slice(0, 60) : "";
    if (status === 429) {
      this.nextAttemptAt = now + RATE_LIMIT_BACKOFF_MS;
      this.noteOnce("429", "highspeed draw rate-limited (429) — backing off 5s");
      return;
    }
    if (status !== 200 || !body) {
      if (status === 400) {
        // Parameter-level rejection — the ACCOUNT is fine (same account, same
        // recipe: glm-5.3 draws 200-miss where glm-5.3-flash 400s, live
        // 2026-10-14). Block only this model; never the account-level cache.
        this.drawBlockedUntil.set(model.trim().toLowerCase(), now + UNAVAILABLE_MS);
        this.noteOnce(
          `draw400-${model}`,
          `draw rejected (HTTP 400${wireCode !== null ? ` code=${wireCode}` : ""}${wireMsg ? ` ${wireMsg}` : ""}) — model ${model} ineligible for draw, skipping it`,
        );
      } else {
        this.unavailableUntil = now + UNAVAILABLE_MS;
        this.noteOnce(`http${status}`, `highspeed draw unavailable (HTTP ${status}${wireCode !== null ? ` code=${wireCode}` : ""}${wireMsg ? ` ${wireMsg}` : ""}) — negative-cached 10min`);
      }
      return;
    }
    const code = wireCode;
    if (code !== 0) {
      // 3404 = account-level "highspeed temporarily unavailable" (live 2026-10-10).
      // Any other business code is treated the same: negative-cache, never spin.
      this.unavailableUntil = now + UNAVAILABLE_MS;
      this.noteOnce(`biz${code}`, `highspeed draw rejected (code=${code} ${String(body.msg ?? "").slice(0, 60)}) — negative-cached 10min`);
      return;
    }
    // Deliberate deviation: `next_draw_at` is ignored on a miss — the loop
    // retries at the heartbeat cadence until the idle window closes.
    const wire = body.data?.card;
    if (wire && typeof wire.card_id === "string" && wire.card_id
      && typeof wire.model === "string" && wire.model
      && typeof wire.expires_at === "number" && wire.expires_at > now) {
      this.card = {
        cardId: wire.card_id,
        taskId: typeof wire.task_id === "string" ? wire.task_id : taskId,
        model: wire.model,
        issuedAt: typeof wire.issued_at === "number" ? wire.issued_at : now,
        expiresAt: wire.expires_at,
      };
      this.stopTimer();
      this.onEvent?.(`highspeed: card drawn (${this.card.cardId.slice(0, 12)}… model=${this.card.model} window=${Math.round((this.card.expiresAt - now) / 1000)}s)`);
    } else {
      this.noteOnce("miss", "highspeed draw miss (card=null) — retrying at max rate");
    }
  }

  private noteOnce(key: string, message: string): void {
    if (this.notedKeys.has(key)) return;
    this.notedKeys.add(key);
    this.onEvent?.(`highspeed: ${message}`);
  }
}

/** Every constructed manager — shutdown hygiene for the background loops. */
const liveManagers = new Set<HighspeedManager>();

/** Stop every draw loop (serve-mode shutdown path, alongside claim/captcha). */
export function shutdownAllHighspeed(): void {
  for (const manager of liveManagers) manager.stop();
  liveManagers.clear();
}

let defaultManager: HighspeedManager | null = null;
let defaultManagerKey = "";

/**
 * Process-wide manager (single card slot, like the official host service).
 * Returns null when `highspeed.enabled` is false. Recreated when origin/models
 * change (Android `setConfig`) — the previous instance's loop is stopped.
 * Also warms the remote provider-config snapshot (client/configs → CDN →
 * highspeed baseUrl override; see `provider-config.ts`) — production path
 * only: tests injecting `opts.highspeed` bypass this and never touch the
 * network.
 */
export function getDefaultHighspeedManager(config: {
  highspeed: { enabled: boolean; origin: string; models: string[] };
  identity: { deviceMid?: string; appVersion: string };
}): HighspeedManager | null {
  if (!config.highspeed.enabled) return null;
  void warmHighspeedProviderConfig({ origin: config.highspeed.origin, appVersion: config.identity.appVersion });
  const key = `${config.highspeed.origin}\n${config.highspeed.models.join(",")}\n${config.identity.deviceMid}`;
  if (!defaultManager || key !== defaultManagerKey) {
    defaultManager?.stop();
    if (defaultManager) liveManagers.delete(defaultManager);
    defaultManager = new HighspeedManager({
      origin: config.highspeed.origin,
      models: config.highspeed.models,
      deviceMid: config.identity.deviceMid,
      // State transitions (drawn / miss / cooldown / dropped / idle-stopped) are
      // otherwise silent in production — surface each once per kind.
      onEvent: (message) => console.log(`client-${message}`),
    });
    defaultManagerKey = key;
  }
  return defaultManager;
}

/** Rewrite the `model` field of a JSON request body (parse failure → unchanged). */
export function rewriteBodyModel(body: string, model: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.model !== "string") return body;
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Carded inference URL — the official client's `account:{family}-highspeed-card`
 * providers are pinned by `zcode-builtin.json` providerRules (rev 31=3.15.1
 * through rev 43, both zai and bigmodel families) to
 * `{origin}/api/v1/highspeed/anthropic`, and the anthropic SDK appends
 * `/v1/messages`. Carded requests therefore reroute here — NOT the coding-plan
 * provider URL (ultra after routing). Found 2026-11-09; the 2026-10-14
 * "挂卡头面仅三差异" audit missed this because the URL lives in the provider
 * config JSON, not the bundle code.
 */
export function highspeedLlmUrl(origin: string): string {
  return highspeedLlmUrlFromBase(`${origin.replace(/\/+$/u, "")}/api/v1/highspeed/anthropic`);
}

/**
 * Full carded inference URL from a provider-rule baseUrl (the remote snapshot
 * in `provider-config.ts` may override the pinned default above; the official
 * anthropic SDK appends `/v1/messages` to whatever base the provider rules
 * carry, and so do we).
 */
export function highspeedLlmUrlFromBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/v1/messages`;
}

/**
 * Apply the official highspeed auth shape to upstream header pairs
 * (`buildHighspeedTurnExecution` requestAuth): the coding-plan dual
 * `x-api-key`/`Authorization` values are replaced by the zcode JWT, and the
 * coding-plan / card headers are appended.
 */
export function applyHighspeedCardHeaders(
  pairs: UpstreamHeaderPair[],
  card: HighspeedCard,
  auth: HighspeedAuth,
): UpstreamHeaderPair[] {
  const bare = auth.jwt.startsWith("Bearer ") ? auth.jwt.slice(7).trim() : auth.jwt;
  const bearer = `Bearer ${bare}`;
  const swapped = pairs.map(([name, value]): UpstreamHeaderPair => {
    const lower = name.toLowerCase();
    // official requestAuth: apiKey slot (SDK x-api-key) carries the bare JWT,
    // the Authorization header carries the Bearer form
    if (lower === "x-api-key") return [name, bare];
    if (lower === "authorization") return [name, bearer];
    return [name, value];
  });
  return [
    ...swapped,
    ["X-Bigmodel-Authorization", `Bearer ${auth.codingPlanAuth}`],
    ["Bigmodel-Target-Type", "PERSONAL"],
    ["X-Highspeed-Card-ID", card.cardId],
  ];
}

/**
 * True when an upstream response means the carded route is unusable and the
 * request must fall back to the session model (official `selectionFallback`
 * semantics): HTTP 401, biz `code:3402`, or a 200-wrapped business envelope
 * (`{"code":1005,"msg":"exceed quota limit",…}`).
 *
 * The 200+code shape went live with the 2026-11-09 reroute to the dedicated
 * highspeed endpoint: a quota-dead card answers HTTP 200 with that envelope,
 * which the old 401/3402-only predicate never matched — the dead card was
 * never dropped and every carded non-stream request crashed the translator
 * (`resp.content.filter` on a body with no `content`, /v1/responses → 500).
 * Deliberate deviation: the official client was only OBSERVED rejecting
 * 401/3402; extending the same fallback to code-bearing 200 bodies is our
 * call, not a mirror. A legitimate Anthropic success body never carries a
 * top-level `code`, so false positives are structurally impossible; SSE
 * bodies are never sniffed (teeing a live stream would buffer it whole).
 */
export async function isHighspeedCardRejection(resp: Response): Promise<boolean> {
  if (resp.status === 401) return true;
  if (resp.status !== 200 && resp.status < 500) {
    try {
      const body = await resp.clone().json() as { code?: unknown };
      if (body?.code === 3402) return true;
    } catch {
      // non-JSON — not a card rejection
    }
    return false;
  }
  if (resp.status === 200 && (resp.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const body = await resp.clone().json() as { code?: unknown };
      if (body && typeof body === "object" && body.code !== undefined) return true;
    } catch {
      // non-JSON — not a card rejection
    }
  }
  return false;
}

/** Credential → HighspeedAuth (returns null when the JWT needed for draw is missing). */
export function highspeedAuthFrom(cred: Credential): HighspeedAuth | null {
  if (!cred.jwt?.trim()) return null;
  return {
    jwt: cred.jwt,
    codingPlanAuth: credentialString(cred),
    family: cred.provider === "bigmodel" ? "bigmodel" : "zai",
  };
}
