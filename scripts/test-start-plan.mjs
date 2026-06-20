/**
 * Manual start-plan smoke test — run before opening PR.
 * JWT: data/store.json (zcode_jwt) or ZCODE_JWT env override.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.resolve(ROOT, "../../data/store.json");

function readJwtFromStore() {
  if (!fs.existsSync(STORE)) return null;
  const store = JSON.parse(fs.readFileSync(STORE, "utf8"));
  const acc = (store.accounts || []).find(
    (a) => a.kind === "zcode_jwt" && a.api_key?.startsWith("eyJ") && a.status !== "disabled",
  );
  return acc?.api_key?.trim() || null;
}

const JWT = process.env.ZCODE_JWT?.trim() || readJwtFromStore();

if (!JWT) {
  console.error("No JWT: set ZCODE_JWT or add zcode_jwt account to data/store.json");
  process.exit(1);
}

const MESSAGES_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
const BILLING_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/quota";
const CONFIGS_URL = "https://zcode.z.ai/api/v1/client/configs?app_version=3.1.2&platform=win32-x64";

const SYSTEM_BLOCKS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/proxy/zcode_system.json"), "utf8"),
);

async function fetchCaptchaConfig() {
  const res = await fetch(CONFIGS_URL);
  const json = await res.json();
  const cap = json?.data?.configs?.captcha ?? {};
  return {
    sceneId: String(cap.sceneId || "11xygtvd"),
    region: String(cap.region || "sgp"),
    prefix: String(cap.prefix || "no8xfe"),
  };
}

function solveCaptcha(scene, region, prefix) {
  const solver = path.join(ROOT, "captcha_node/solver.js");
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [solver, scene, region, prefix], {
      cwd: path.join(ROOT, "captcha_node"),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("captcha timeout"));
    }, 45_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("VERIFY_PARAM=")) {
          resolve(line.slice("VERIFY_PARAM=".length).trim());
          return;
        }
      }
      reject(new Error(`captcha exit ${code}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`));
    });
  });
}

function buildBody() {
  return {
    model: "GLM-5.2",
    max_tokens: 64,
    stream: false,
    thinking: { type: "enabled", budget_tokens: 32000 },
    output_config: { effort: "max" },
    system: [...SYSTEM_BLOCKS],
    messages: [{ role: "user", content: [{ type: "text", text: "ответь одним словом: ок" }] }],
  };
}

function chatHeaders(captchaParam, region) {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: `Bearer ${JWT}`,
    "http-referer": "https://zcode.z.ai",
    "user-agent": "ZCode/3.1.2",
    "x-zcode-app-version": "3.1.2",
    "x-title": "Z Code@electron",
    "x-zcode-agent": "glm",
    "x-platform": "win32-x64",
    "x-aliyun-captcha-verify-param": captchaParam,
    "x-aliyun-captcha-verify-region": region,
  };
}

async function main() {
  console.log("=== 1. Billing ===");
  const billingRes = await fetch(BILLING_URL, {
    headers: { authorization: `Bearer ${JWT}`, accept: "application/json" },
  });
  const billingText = await billingRes.text();
  console.log(`billing HTTP ${billingRes.status}: ${billingText.slice(0, 200)}`);

  console.log("\n=== 2. Captcha (jsdom traceless) ===");
  const cfg = await fetchCaptchaConfig();
  console.log("config:", cfg);
  const t0 = Date.now();
  const verifyParam = await solveCaptcha(cfg.sceneId, cfg.region, cfg.prefix);
  console.log(`captcha OK in ${Date.now() - t0}ms, param length=${verifyParam.length}`);

  console.log("\n=== 3. Chat WITH system blocks + captcha ===");
  const goodRes = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: chatHeaders(verifyParam, cfg.region),
    body: JSON.stringify(buildBody()),
  });
  const goodText = await goodRes.text();
  console.log(`with fix HTTP ${goodRes.status}: ${goodText.slice(0, 500)}`);

  let parsed;
  try {
    parsed = JSON.parse(goodText);
  } catch {
    parsed = null;
  }

  const reply = parsed?.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (goodRes.ok && reply) {
    console.log("\n✅ SUCCESS — reply:", reply.slice(0, 100));
    process.exit(0);
  }

  console.log("\n❌ FAILED");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
