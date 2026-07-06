/**
 * Ambient module declarations for non-TS assets imported as text.
 *
 * Bun loads `.txt` with its `text` loader: a plain string at runtime, and
 * embedded as a string constant under `bun build --compile`, so the web UI
 * ships inside the single-file executable. (`*.html` is avoided because Bun's
 * built-in html loader returns an opaque HTMLBundle rather than raw text.)
 *
 * `@types/bun` already declares `*.txt` as a string default export; this file
 * documents the intent and keeps type-checking stable if that ever changes.
 */
declare module "*.txt" {
  const content: string;
  export default content;
}

