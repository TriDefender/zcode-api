import { describe, expect, it } from "bun:test";
import { isCaptchaIpBlockError } from "./captcha-token.js";

describe("isCaptchaIpBlockError", () => {
  it("detects the 'too many captcha requests' family", () => {
    expect(
      isCaptchaIpBlockError(
        'verify rejected: {"verifyCode":"F005","Message":"too many captcha requests"}',
      ),
    ).toBe(true);
    expect(
      isCaptchaIpBlockError('Request was denied due to risk control. retry later'),
    ).toBe(true);
    expect(isCaptchaIpBlockError("rate limit exceeded")).toBe(true);
    expect(isCaptchaIpBlockError("frequent requests detected")).toBe(true);
  });

  it("does not flag F008 duplicates (local retry, not an IP block)", () => {
    expect(
      isCaptchaIpBlockError('duplicate certifyId "F008"'),
    ).toBe(false);
    expect(
      isCaptchaIpBlockError('{"verifyCode":"F008"}'),
    ).toBe(false);
  });

  it("does not flag stalls/timeouts (retryable without an IP reset)", () => {
    expect(isCaptchaIpBlockError("captcha solve stall pe=pe.062.abc.js")).toBe(false);
    expect(isCaptchaIpBlockError("captcha solve timeout pe=pe.089")).toBe(false);
    expect(isCaptchaIpBlockError("solver returned empty")).toBe(false);
  });

  it("ignores happy-path / non-captcha messages", () => {
    expect(isCaptchaIpBlockError("")).toBe(false);
    expect(isCaptchaIpBlockError("captcha failed after 4 attempts: duplicate certifyId ?")).toBe(false);
  });
});