/**
 * SSE keepalive stream generator.
 *
 * Emits pure SSE comment frames (`: keepalive\n\n`) at a fixed interval.
 * Used by the async bridge to keep the client connection alive during
 * ticket-queue wait — comment frames are universally ignored by spec-compliant
 * SSE clients (OpenAI / Anthropic SDKs) but reset their idle-timeout timers.
 *
 * Never emits `data:` frames — those carry semantic events and would confuse
 * strict SDK parsers (e.g. `@ai-sdk/anthropic` zod schemas throw on unknown
 * `type` values, killing the stream — see plan §3.6 anti-pattern #1).
 */

export interface KeepaliveOptions {
  /** Interval between comment frames in ms. */
  intervalMs: number;
  /** Comment text. Default `"keepalive"`. Must not contain newlines. */
  text?: string;
  /** External abort — when fired, the stream closes gracefully. */
  signal?: AbortSignal;
}

/**
 * Build a `ReadableStream<Uint8Array>` that emits `: ${text}\n\n` every
 * `intervalMs`. The stream closes when `signal` aborts. Text encoder is
 * reused across frames; the underlying buffer is fresh per emit.
 *
 * Cadence guarantee: first emit happens after `intervalMs` (NOT immediately)
 * so callers can compose with upstream-output streams without a leading comment.
 */
export function keepaliveStream(opts: KeepaliveOptions): ReadableStream<Uint8Array> {
  const text = (opts.text ?? "keepalive").replace(/[\r\n]/g, " ");
  const frame = new TextEncoder().encode(`: ${text}\n\n`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (opts.signal) {
        if (opts.signal.aborted) {
          aborted = true;
          controller.close();
          return;
        }
        opts.signal.addEventListener("abort", () => {
          aborted = true;
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          try { controller.close(); } catch { /* already closed */ }
        }, { once: true });
      }

      const tick = (): void => {
        if (aborted) return;
        try {
          controller.enqueue(frame);
        } catch {
          // Controller closed by consumer; stop the timer.
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          return;
        }
        timer = setTimeout(tick, opts.intervalMs);
      };
      timer = setTimeout(tick, opts.intervalMs);
    },
    cancel() {
      aborted = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  });
}

/**
 * Emit a single immediate keepalive frame as a `Uint8Array`.
 * Useful for flushing one frame before pausing on a long upstream call.
 */
export function keepaliveFrame(text: string = "keepalive"): Uint8Array {
  const clean = text.replace(/[\r\n]/g, " ");
  return new TextEncoder().encode(`: ${clean}\n\n`);
}
