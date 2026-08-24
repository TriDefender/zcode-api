/** Decode certifyId from a base64 Aliyun verify-param blob. */
export function parseCertifyId(param: string): string | null {
  try {
    const json = JSON.parse(Buffer.from(param, "base64").toString("utf8")) as {
      certifyId?: unknown;
    };
    return typeof json.certifyId === "string" && json.certifyId.length > 0
      ? json.certifyId
      : null;
  } catch {
    return null;
  }
}

/** Aliyun F008 — certifyId / verify token already consumed or duplicated. */
export function isCaptchaDuplicateError(message: string): boolean {
  return /F008|"verifyCode"\s*:\s*"F008"/i.test(message);
}

/**
 * Aliyun IP-block family: no-captcha possible because the mint IP has been
 * flagged ("too many captcha requests"). Distinct from F008 (duplicate
 * certifyId) and from pe-VM stalls/timeouts, which are local-side issues that
 * a retry can fix without rotating the IP.
 */
const CAPTCHA_IP_BLOCK_RE =
  /too many|request was denied|risk control|frequent|rate\s*limit|exceeded.*(?:request|limit)|ip\s*suspicious|denied due to|retry later/i;

export function isCaptchaIpBlockError(message: string): boolean {
  if (isCaptchaDuplicateError(message)) return false;
  return CAPTCHA_IP_BLOCK_RE.test(message);
}
