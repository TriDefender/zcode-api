/**
 * Serve the built-in web dashboard (single-page app).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DASHBOARD_PATH = join(import.meta.dir, "../web/dashboard.html");

export function handleDashboard(_req: Request): Response {
  const html = readFileSync(DASHBOARD_PATH, "utf-8");
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
