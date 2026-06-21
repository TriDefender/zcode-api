/**
 * Web-driven Start Plan onboarding — OAuth poll + quota provisioning.
 */
import { randomBytes } from "node:crypto";
import { ZaiOAuthClient, type OAuthInitResponse } from "./oauth.js";
import { onboardStartPlan } from "./onboard.js";
import { saveCredential } from "./store.js";
import type { AccountPool } from "./account-pool.js";

export type OnboardPhase =
  | "oauth_pending"
  | "provisioning"
  | "done"
  | "error";

export interface OnboardJobPublic {
  id: string;
  phase: OnboardPhase;
  authorizeUrl?: string;
  expiresAt?: number;
  error?: string;
  accountId?: string;
  quotaReady?: boolean;
  balanceCount?: number;
}

interface OnboardJob extends OnboardJobPublic {
  oauthInit?: OAuthInitResponse;
  launchDesktop: boolean;
  accountPool: AccountPool;
  polling: boolean;
}

export class OnboardJobManager {
  private jobs = new Map<string, OnboardJob>();

  start(opts: { launchDesktop?: boolean; accountPool: AccountPool }): Promise<OnboardJobPublic> {
    return this.createJob(opts);
  }

  private async createJob(opts: {
    launchDesktop?: boolean;
    accountPool: AccountPool;
  }): Promise<OnboardJobPublic> {
    const oauth = new ZaiOAuthClient();
    const init = await oauth.init("zai");
    const id = randomBytes(8).toString("hex");
    const job: OnboardJob = {
      id,
      phase: "oauth_pending",
      authorizeUrl: init.authorizeUrl,
      expiresAt: init.expiresAt,
      oauthInit: init,
      launchDesktop: opts.launchDesktop !== false,
      accountPool: opts.accountPool,
      polling: false,
    };
    this.jobs.set(id, job);
    void this.runOAuthPoll(job, oauth);
    return this.publicView(job);
  }

  get(id: string): OnboardJobPublic | undefined {
    const job = this.jobs.get(id);
    return job ? this.publicView(job) : undefined;
  }

  private publicView(job: OnboardJob): OnboardJobPublic {
    return {
      id: job.id,
      phase: job.phase,
      authorizeUrl: job.authorizeUrl,
      expiresAt: job.expiresAt,
      error: job.error,
      accountId: job.accountId,
      quotaReady: job.quotaReady,
      balanceCount: job.balanceCount,
    };
  }

  private async runOAuthPoll(job: OnboardJob, oauth: ZaiOAuthClient): Promise<void> {
    if (job.polling || !job.oauthInit) return;
    job.polling = true;

    const init = job.oauthInit;
    const deadline = init.expiresAt;
    const intervalMs = Math.max(1000, init.pollIntervalSec * 1000);

    try {
      while (Date.now() < deadline && job.phase === "oauth_pending") {
        await sleep(intervalMs);
        const result = await oauth.poll(init.flowId, init.pollToken);
        if (result.status === "failed") {
          job.phase = "error";
          job.error = "Authorization failed or expired.";
          return;
        }
        if (result.status === "ready") {
          const accessToken = result.zai?.access_token ?? result.token;
          const jwt = result.token;
          if (!accessToken || !jwt?.trim()) {
            job.phase = "error";
            job.error = "OAuth succeeded but no Start Plan JWT was returned.";
            return;
          }
          job.phase = "provisioning";
          await this.provision(job, {
            accessToken,
            jwt: jwt.trim(),
            userId: result.userId,
            user: result.user,
          });
          return;
        }
      }
      if (job.phase === "oauth_pending") {
        job.phase = "error";
        job.error = "Authorization timed out.";
      }
    } catch (err) {
      job.phase = "error";
      job.error = (err as Error).message;
    } finally {
      job.polling = false;
    }
  }

  private async provision(
    job: OnboardJob,
    oauth: { accessToken: string; jwt: string; userId?: string; user?: Record<string, unknown> },
  ): Promise<void> {
    try {
      const result = await onboardStartPlan({
        provider: "zai",
        jwt: oauth.jwt,
        accessToken: oauth.accessToken,
        userId: oauth.userId,
        userInfo: oauth.user,
        launchDesktop: job.launchDesktop,
      });
      await saveCredential(result.credential);
      const accountId = job.accountPool.addFromCredential(result.credential);
      job.accountId = accountId;
      job.quotaReady = result.quotaReady;
      job.balanceCount = result.balanceCount;
      job.phase = "done";
    } catch (err) {
      job.phase = "error";
      job.error = (err as Error).message;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
