/** Classify upstream failures for account pool rotation. */
export type UpstreamFailureKind =
  | "ok"
  | "quota"
  | "blocked"
  | "auth"
  | "captcha"
  | "other";

export async function classifyUpstreamFailure(
  resp: Response,
  isCaptchaFailure: (r: Response) => Promise<boolean>,
): Promise<UpstreamFailureKind> {
  if (resp.ok) return "ok";

  const text = await resp.clone().text().catch(() => "");
  const low = text.toLowerCase();

  if (low.includes("3012") || (resp.status === 405 && low.includes("method not allowed"))) {
    return "blocked";
  }
  if (
    low.includes("1005") ||
    low.includes("exceed quota") ||
    low.includes("quota limit") ||
    low.includes("insufficient") ||
    resp.status === 402
  ) {
    return "quota";
  }
  if (resp.status === 401) return "auth";
  if (await isCaptchaFailure(resp)) return "captcha";
  return "other";
}
