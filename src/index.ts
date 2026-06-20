/**
 * Entry point — load config, create auth manager, start proxy server.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { loadConfig } from "./config/loader.js";
import { EXAMPLE_CONFIG_YAML } from "./config/template.js";
import { AuthManager } from "./auth/manager.js";
import { startServer } from "./server/server.js";
import { loadCredential, saveCredential, clearCredential, getStorePath } from "./auth/store.js";
import { ZaiOAuthClient, BigmodelOAuthClient } from "./auth/oauth.js";
import { KeyResolver } from "./auth/resolver.js";
import { loadZcodeJwtFromDesktop, decodeJwtUserId } from "./auth/zcode-credentials.js";
import { onboardStartPlan } from "./auth/onboard.js";
import type { Credential } from "./auth/types.js";
import type { ProviderId } from "./provider/types.js";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const VERSION = "1.4.5";

main();

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    const configPath = cmd === "serve" ? args[1] : cmd;
    serve(configPath);
  } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`zcode-proxy ${VERSION}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy serve [config.yaml]   Start the proxy server (default)
  zcode-proxy auth login <provider> [--import]
                                    OAuth login, or import API key from ~/.zcode/v2/config.json
  zcode-proxy auth import-jwt [zai] Import Start Plan JWT from ~/.zcode/v2/credentials.json
  zcode-proxy auth onboard <zai>      OAuth login + sync desktop + provision quota
  zcode-proxy auth logout           Clear stored credentials
  zcode-proxy auth status           Show current authentication state
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Start server with default config.yaml
  zcode-proxy auth login zai         OAuth login for Z.AI (captures start-plan JWT)
  zcode-proxy auth import-jwt        Import JWT from ZCode desktop (start-plan)
  zcode-proxy auth onboard zai       Full new-account setup (OAuth → ZCode → quota)
  zcode-proxy auth status           Check if logged in
`);
}

async function serve(configPath?: string): Promise<void> {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    writeFileSync(path, EXAMPLE_CONFIG_YAML, "utf-8");
    console.log(`Created ${path} from bundled template.`);
    console.log(`Edit auth.apiKey, or run: zcode-proxy auth login <zai|bigmodel>\n`);
  }
  const config = loadConfig(path);

  if (config.plan === "start-plan" && config.auth.mode !== "oauth") {
    console.error("start-plan requires auth.mode: oauth (set plan: start-plan and auth.mode: oauth in config.yaml)");
    process.exit(1);
  }

  const auth = new AuthManager({
    mode: config.auth.mode,
    provider: config.provider,
    apiKey: config.auth.apiKey ?? config.providers[config.provider].credential,
  });

  if (config.auth.mode === "oauth") {
    const cred = await loadCredential();
    if (!cred) {
      console.error("Not logged in. Run: zcode-proxy auth login " + config.provider);
      process.exit(1);
    }
    auth.setOAuthCredential(cred);
    if (config.plan === "start-plan" && !cred.jwt?.trim()) {
      console.error("start-plan requires a JWT. Run: bun run src/index.ts auth import-jwt");
      process.exit(1);
    }
  }

  const server = startServer({ config, auth });
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy listening on ${url}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  auth mode: ${config.auth.mode}`);
  console.log(`  models: ${config.models.length} available`);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.stop(true);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}

function authCommand(args: string[]): void {
  const sub = args[0];

  if (sub === "login") {
    authLogin(args.slice(1));
  } else if (sub === "import-jwt") {
    authImportJwt(args.slice(1));
  } else if (sub === "onboard") {
    authOnboard(args.slice(1));
  } else if (sub === "logout") {
    authLogout();
  } else if (sub === "status") {
    authStatus();
  } else {
    console.error("Usage: zcode-proxy auth <login|import-jwt|onboard|logout|status>");
    process.exit(1);
  }
}

async function authOnboard(args: string[]): Promise<void> {
  const provider = (args.find((a) => a === "zai" || a === "bigmodel") ?? "zai") as ProviderId;
  const skipDesktop = args.includes("--no-zcode");

  if (provider !== "zai") {
    console.error("Start Plan onboard currently supports: zai");
    process.exit(1);
  }

  console.log("Start Plan onboard — OAuth login, sync ZCode desktop, provision quota\n");

  const { accessToken, userId, jwt, user } = await runOAuth(provider);
  if (!jwt?.trim()) {
    console.error("OAuth succeeded but no Start Plan JWT in response. Try logging into ZCode desktop instead.");
    process.exit(1);
  }

  const result = await onboardStartPlan({
    provider,
    jwt,
    accessToken,
    userId,
    userInfo: user,
    launchDesktop: !skipDesktop,
  });

  await saveCredential(result.credential);

  console.log(`\nOnboard complete (${result.quotaReady ? "quota ready" : "quota pending"}).`);
  console.log(`  User ID: ${result.credential.userId ?? "?"}`);
  console.log(`  Proxy store: ${getStorePath()}`);
  console.log("\nStart proxy: bun run src/index.ts");
  if (!result.quotaReady) process.exit(1);
}

async function authImportJwt(args: string[]): Promise<void> {
  const provider = (args[0] ?? "zai") as ProviderId;
  if (provider !== "zai" && provider !== "bigmodel") {
    console.error("Usage: zcode-proxy auth import-jwt [zai|bigmodel]");
    process.exit(1);
  }

  const jwt = loadZcodeJwtFromDesktop();
  if (!jwt) {
    console.error("No JWT in ~/.zcode/v2/credentials.json.");
    console.error("Log into the ZCode desktop app first, then retry.");
    process.exit(1);
  }

  const cred: Credential = {
    apiKey: "start-plan",
    provider,
    jwt,
    userId: decodeJwtUserId(jwt),
  };

  await saveCredential(cred);
  console.log(`\nImported start-plan JWT for ${provider}.`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  JWT:     ${jwt.slice(0, 16)}...`);
  console.log(`  Stored:  ${getStorePath()}`);
  console.log("\nSet config.yaml: auth.mode: oauth, plan: start-plan, then run serve.");
}

async function authLogin(args: string[]): Promise<void> {
  const provider = args[0] as ProviderId | undefined;
  const importMode = args.includes("--import");

  if (!provider || (provider !== "zai" && provider !== "bigmodel")) {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import]");
    process.exit(1);
  }

  console.log(`Logging in: ${provider}${importMode ? " (import)" : " (OAuth)"}\n`);

  let cred: Credential;

  if (importMode) {
    cred = importFromZCodeConfig(provider);
  } else {
    const { accessToken, userId, jwt } = await runOAuth(provider);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId);
    if (jwt) cred.jwt = jwt;
  }

  await saveCredential(cred);
  console.log(`\nLogged in as ${provider}.`);
  if (cred.apiKey && cred.apiKey !== "start-plan") {
    console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  }
  if (cred.jwt) console.log(`  Start-plan JWT: ${cred.jwt.slice(0, 16)}...`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  console.log(`  Stored:  ${getStorePath()}`);
}

function authLogout(): void {
  if (!existsSync(getStorePath())) {
    console.log("Not logged in.");
    return;
  }
  clearCredential();
  console.log("Logged out. Credentials removed.");
}

async function authStatus(): Promise<void> {
  const cred = await loadCredential();
  if (!cred) {
    console.log("Not logged in.");
    console.log("Run: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  console.log(`Logged in: ${cred.provider}`);
  if (cred.userId) console.log(`  User ID: ${cred.userId}`);
  if (cred.apiKey && cred.apiKey !== "start-plan") {
    console.log(`  API Key: ${cred.apiKey.substring(0, 12)}...`);
  }
  if (cred.jwt) console.log(`  Start-plan JWT: ${cred.jwt.slice(0, 16)}...`);
  console.log(`  Store:   ${getStorePath()}`);
  if (!cred.jwt) {
    console.log("\n  For start-plan: bun run src/index.ts auth import-jwt");
  }
}

async function runOAuth(provider: ProviderId): Promise<{
  accessToken: string;
  userId?: string;
  jwt?: string;
  user?: Record<string, unknown>;
}> {
  if (provider === "bigmodel") {
    const oauth = new BigmodelOAuthClient();
    const result = await oauth.authorize((url) => {
      console.log("Open this URL to authorize:\n");
      console.log(`  ${url}\n`);
      console.log("Waiting for authorization... (expires in 300s)\n");
      openBrowser(url);
    });
    return { accessToken: result.accessToken, userId: result.userId, jwt: result.jwt };
  }

  const oauth = new ZaiOAuthClient();
  const init = await oauth.init("zai");

  console.log("Open this URL to authorize:\n");
  console.log(`  ${init.authorizeUrl}\n`);
  console.log(`Waiting... (expires in ${Math.floor((init.expiresAt - Date.now()) / 1000)}s)\n`);

  openBrowser(init.authorizeUrl);

  const result = await oauth.waitForAuth(init);
  return {
    accessToken: result.accessToken,
    userId: result.userId,
    jwt: result.jwt,
    user: result.user,
  };
}

function importFromZCodeConfig(provider: ProviderId): Credential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Cannot read ${configPath}.`);
    console.error("Make sure ZCode is installed and you've logged in at least once.");
    process.exit(1);
  }

  const config = JSON.parse(raw) as {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };

  const providerKey = `builtin:${provider}-coding-plan`;
  const entry = config.provider?.[providerKey];
  const apiKey = entry?.options?.apiKey?.trim();

  if (!apiKey) {
    console.error(`No API key for ${providerKey} in ZCode config.`);
    process.exit(1);
  }

  const startPlanKey = `builtin:${provider}-start-plan`;
  let jwt = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || undefined;
  if (!jwt) jwt = loadZcodeJwtFromDesktop() ?? undefined;

  console.log(`Imported from ${configPath}`);
  if (jwt) console.log(`  Start-plan JWT: ${jwt.slice(0, 12)}...`);
  return { apiKey, provider, jwt };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", `start "" "${url}"`], {
        detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch { /* user copies URL manually */ }
}
