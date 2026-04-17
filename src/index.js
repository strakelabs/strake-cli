#!/usr/bin/env node
// Strake CLI — tiny zero-dep client for app.strake.sh/api/v1.
//
// Handwritten command dispatch + prompts to keep the install footprint to
// literally one file. Node 18+ gives us fetch, readline/promises, and os.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit, argv, env as processEnv } from "node:process";

const API_BASE = processEnv.STRAKE_API_BASE || "https://app.strake.sh";
const CONFIG_DIR = join(homedir(), ".config", "strake");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// Respect NO_COLOR (https://no-color.org)
const NC = !!processEnv.NO_COLOR;
const BOLD   = NC ? "" : "\x1b[1m";
const DIM    = NC ? "" : "\x1b[2m";
const RED    = NC ? "" : "\x1b[31m";
const GREEN  = NC ? "" : "\x1b[32m";
const YELLOW = NC ? "" : "\x1b[33m";
const RESET  = NC ? "" : "\x1b[0m";

// ---- main dispatch ----

async function main() {
  const [, , topCmd, ...args] = argv;
  try {
    switch (topCmd) {
      // Noun-first groups
      case "auth":     return await authCmd(args);
      case "endpoint": return await endpointCmd(args);
      case "token":    return await tokenCmd(args);
      case "config":   return await configCmd(args);

      // Flat aliases (kept for back-compat)
      case "login":    return await authLogin(args);
      case "logout":   return await authLogout();
      case "whoami":   return await authWhoami();
      case "endpoints":
      case "list":     return await endpointList(args);
      case "connect":  return await endpointCreate(args);
      case "get":      return await endpointShow(args);
      case "delete":
      case "revoke":   return await endpointDelete(args);
      case "rotate-key": return await endpointRotateKey(args);
      case "tokens":   return await tokenCmd(args);  // tokens → token group
      case "env":      return await endpointEnv(args);
      case "run":      return await run(args);

      case "help":
      case "--help":
      case "-h":
      case undefined:  return printHelp();

      case "version":
      case "--version":
      case "-v": {
        const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        console.log(pkg.version);
        return;
      }

      default:
        console.error(`${RED}Unknown command:${RESET} ${topCmd}`);
        printHelp();
        exit(1);
    }
  } catch (err) {
    console.error(`${RED}error:${RESET} ${err.message}`);
    if (processEnv.STRAKE_DEBUG) console.error(err);
    exit(1);
  }
}

// ---- group dispatchers ----

async function authCmd(args) {
  const sub = args[0];
  switch (sub) {
    case "login":  return await authLogin(args.slice(1));
    case "logout": return await authLogout();
    case "whoami": return await authWhoami();
    default:
      throw new Error("usage: strake auth <login|logout|whoami>");
  }
}

async function endpointCmd(args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":                   return await endpointList(rest);
    case "create":                 return await endpointCreate(rest);
    case "show":
    case "describe":               return await endpointShow(rest);
    case "delete":                 return await endpointDelete(rest);
    case "rotate-key":             return await endpointRotateKey(rest);
    case "env":                    return await endpointEnv(rest);
    default:
      throw new Error("usage: strake endpoint <list|create|show|delete|rotate-key|env> …");
  }
}

async function tokenCmd(args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "add":    return await tokenAdd(rest);
    case "list":   return await tokenList(rest);
    case "revoke": return await tokenRevoke(rest);
    case "rotate": return await tokenRotate(rest);
    default:
      throw new Error("usage: strake token <add|list|revoke|rotate> …");
  }
}

async function configCmd(args) {
  const sub = args[0] || "show";
  switch (sub) {
    case "path":
      console.log(CONFIG_PATH);
      return;
    case "show": {
      const cfg = await loadConfig();
      if (!cfg?.token) {
        console.log(`${DIM}(not logged in — run \`strake auth login\`)${RESET}`);
        return;
      }
      console.log(`email     ${cfg.email ?? "—"}`);
      console.log(`token     ${cfg.token.slice(0, 6)}…${cfg.token.slice(-4)}  ${DIM}(masked)${RESET}`);
      console.log(`api_base  ${cfg.api_base || API_BASE}`);
      console.log(`path      ${CONFIG_PATH}`);
      return;
    }
    default:
      throw new Error("usage: strake config <show|path>");
  }
}

// ---- auth commands ----

async function authLogin(args) {
  let token = flag(args, "--token");
  if (!token) {
    console.log(`Mint a personal access token at ${BOLD}${API_BASE}/dashboard/settings${RESET}, then paste it below.`);
    token = (await prompt("Token: ", { silent: true })).trim();
  }
  if (!token) throw new Error("no token provided");
  const me = await apiRequest("GET", "/me", { token });
  await saveConfig({ token, email: me.user.email, api_base: API_BASE });
  console.log(`${GREEN}Logged in as${RESET} ${me.user.email}.`);
}

async function authLogout() {
  if (!existsSync(CONFIG_PATH)) {
    console.log("Not logged in.");
    return;
  }
  await writeFile(CONFIG_PATH, "{}\n", { mode: 0o600 });
  console.log("Logged out.");
}

async function authWhoami() {
  const me = await apiRequest("GET", "/me");
  console.log(me.user.email);
}

// ---- endpoint commands ----

async function endpointList(args) {
  const json = args.includes("--json");
  const { endpoints } = await apiRequest("GET", "/endpoints");
  if (json) {
    console.log(JSON.stringify(endpoints, null, 2));
    return;
  }
  if (endpoints.length === 0) {
    console.log(`${DIM}(no endpoints yet — try \`strake endpoint create openai\`)${RESET}`);
    return;
  }
  const rows = endpoints.map((e) => [
    e.subdomain,
    e.label ?? `${DIM}—${RESET}`,
    e.provider,
    new Date(e.created_at).toISOString().slice(0, 10),
  ]);
  printTable(["SUBDOMAIN", "LABEL", "PROVIDER", "CREATED"], rows);
}

async function endpointCreate(args) {
  const provider = args[0];
  if (!provider) throw new Error("provider required (openai | anthropic | gemini | xai | openrouter | custom)");
  const label = await prompt(`Label (optional) [e.g. Cursor]: `);
  const apiKey = (await prompt(`${providerLabel(provider)} API key: `, { silent: true })).trim();
  if (!apiKey) throw new Error("api key required");

  const body = { provider, api_key: apiKey, label: label.trim() || undefined };
  if (provider === "custom") {
    body.destination_url = (await prompt("Destination URL (https://…): ")).trim();
    body.header_name = (await prompt("Header name [Authorization]: ")).trim() || "Authorization";
    body.header_template = (await prompt("Header value template [Bearer {{secret}}]: ")).trim() || "Bearer {{secret}}";
  }

  const result = await apiRequest("POST", "/endpoints", { body });
  console.log(`\n${GREEN}Endpoint created.${RESET}`);
  console.log(`  URL:   ${result.endpoint.url}`);
  console.log(`  Token: ${BOLD}${result.token.plaintext}${RESET}  ${DIM}← shown once, save it now${RESET}\n`);
  console.log(`Try it:\n  ${DIM}$${RESET} eval "$(strake env ${result.endpoint.subdomain} --token ${result.token.plaintext})"`);
}

async function endpointShow(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("subdomain required");
  const json = args.includes("--json");
  const { endpoint, tokens } = await apiRequest("GET", `/endpoints/${subdomain}`);
  if (json) {
    console.log(JSON.stringify({ endpoint, tokens }, null, 2));
    return;
  }
  console.log(`${BOLD}${endpoint.label ?? "Unlabeled"}${RESET}  (${endpoint.subdomain})`);
  console.log(`  URL:         ${endpoint.url}`);
  console.log(`  Provider:    ${endpoint.provider}`);
  console.log(`  Destination: ${endpoint.destination_url}`);
  console.log(`  Created:     ${new Date(endpoint.created_at).toISOString()}`);
  console.log();
  console.log(`${BOLD}Tokens${RESET}`);
  const active = tokens.filter((t) => t.revoked_at === null);
  if (active.length === 0) {
    console.log(`  ${DIM}(no active tokens)${RESET}`);
  } else {
    const rows = active.map((t) => [t.id, t.label ?? "—", t.preview ?? "—", new Date(t.created_at).toISOString().slice(0, 10)]);
    printTable(["ID", "LABEL", "PREVIEW", "CREATED"], rows, "  ");
  }
}

async function endpointDelete(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("subdomain required");
  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes) {
    const confirm = (await prompt(`Delete endpoint ${BOLD}${subdomain}${RESET}? This can't be undone. Type the subdomain to confirm: `)).trim();
    if (confirm !== subdomain) {
      console.log("Aborted.");
      return;
    }
  }
  await apiRequest("DELETE", `/endpoints/${subdomain}`);
  console.log(`${GREEN}Deleted.${RESET}`);
}

async function endpointRotateKey(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("usage: strake endpoint rotate-key <subdomain>");
  const { endpoint } = await apiRequest("GET", `/endpoints/${subdomain}`);
  console.log(`Rotating upstream ${providerLabel(endpoint.provider)} key on ${BOLD}${subdomain}${RESET}.`);
  console.log(`${DIM}Strake URL and bearer tokens stay the same.${RESET}`);
  const apiKey = (await prompt(`New ${providerLabel(endpoint.provider)} API key: `, { silent: true })).trim();
  if (!apiKey) throw new Error("api key required");
  await apiRequest("POST", `/endpoints/${subdomain}/credential/rotate`, { body: { api_key: apiKey } });
  console.log(`${GREEN}Rotated.${RESET} The next request will use the new upstream key.`);
}

async function endpointEnv(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("subdomain required");
  const explicit = flag(args, "--token");
  const shouldMint = args.includes("--mint");
  let token = explicit;
  if (!token && shouldMint) {
    const { token: t } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
      body: { label: "strake-cli env" },
    });
    token = t.plaintext;
  }
  if (!token) {
    console.error(`${YELLOW}warn:${RESET} no --token given and --mint not set. Pass --token <value> or --mint to issue one on the fly.`);
    exit(1);
  }
  const { endpoint } = await apiRequest("GET", `/endpoints/${subdomain}`);
  console.log(`export OPENAI_BASE_URL="${endpoint.url}/v1"`);
  console.log(`export OPENAI_API_KEY="${token}"`);
}

// ---- token commands ----

async function tokenAdd(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("usage: strake token add <subdomain> [--label <label>]");
  const label = flag(args, "--label");
  const json = args.includes("--json");
  const { token } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
    body: label ? { label } : {},
  });
  if (json) {
    console.log(JSON.stringify({ id: token.id, plaintext: token.plaintext }));
    return;
  }
  console.log(`\n${GREEN}Token created.${RESET} ${DIM}(shown once)${RESET}\n`);
  console.log(`  ${BOLD}${token.plaintext}${RESET}`);
}

async function tokenList(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("usage: strake token list <subdomain>");
  const json = args.includes("--json");
  const { tokens } = await apiRequest("GET", `/endpoints/${subdomain}`);
  const active = tokens.filter((t) => t.revoked_at === null);
  if (json) {
    console.log(JSON.stringify(active, null, 2));
    return;
  }
  if (active.length === 0) {
    console.log(`${DIM}(no active tokens)${RESET}`);
    return;
  }
  const rows = active.map((t) => [t.id, t.label ?? "—", t.preview ?? "—", new Date(t.created_at).toISOString().slice(0, 10)]);
  printTable(["ID", "LABEL", "PREVIEW", "CREATED"], rows);
}

async function tokenRevoke(args) {
  const subdomain = args[0];
  const id = args[1];
  if (!subdomain || !id) throw new Error("usage: strake token revoke <subdomain> <token-id> [--yes]");
  const yes = args.includes("--yes") || args.includes("-y");
  if (!yes && stdin.isTTY) {
    const answer = (await prompt(`Revoke token ${BOLD}${id}${RESET} on ${BOLD}${subdomain}${RESET}? [y/N] `)).trim();
    if (!answer.toLowerCase().startsWith("y")) {
      console.log("Aborted.");
      return;
    }
  }
  await apiRequest("DELETE", `/endpoints/${subdomain}/tokens/${id}`);
  console.log(`${GREEN}Revoked.${RESET}`);
}

async function tokenRotate(args) {
  const subdomain = args[0];
  const oldId = args[1];
  if (!subdomain || !oldId) throw new Error("usage: strake token rotate <subdomain> <old-token-id> [--label <label>]");
  const label = flag(args, "--label");
  const json = args.includes("--json");
  const { token } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
    body: label ? { label } : {},
  });
  try {
    await apiRequest("DELETE", `/endpoints/${subdomain}/tokens/${oldId}`);
  } catch (err) {
    console.error(`${YELLOW}warn:${RESET} minted the new token but failed to revoke ${oldId} (${err.message}). Revoke it manually with \`strake token revoke ${subdomain} ${oldId}\`.`);
  }
  if (json) {
    console.log(JSON.stringify({ id: token.id, plaintext: token.plaintext }));
    return;
  }
  console.log(`\n${GREEN}Rotated.${RESET} ${DIM}(new token shown once)${RESET}\n`);
  console.log(`  ${BOLD}${token.plaintext}${RESET}`);
}

// ---- run command ----

async function run(args) {
  const sepIndex = args.indexOf("--");
  if (sepIndex === -1 || sepIndex === 0) {
    throw new Error("usage: strake run <subdomain> -- <command...>");
  }
  const before = args.slice(0, sepIndex);
  const rest = args.slice(sepIndex + 1);
  const subdomain = before[0];
  if (!subdomain) throw new Error("subdomain required");
  if (rest.length === 0) throw new Error("no command given after --");

  const explicit = flag(before, "--token");
  let token = explicit;
  let ephemeralTokenId = null;
  if (!token) {
    const { token: t } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
      body: { label: `strake-cli run ${rest[0]}` },
    });
    token = t.plaintext;
    ephemeralTokenId = t.id;
  }
  const { endpoint } = await apiRequest("GET", `/endpoints/${subdomain}`);

  // Only set env vars matching the endpoint's wire protocol. Setting both
  // OPENAI_* and ANTHROPIC_* hijacks SDKs that auto-pick up whichever is
  // present — e.g. pointing `claude` at an openai endpoint breaks its
  // connection to the real Anthropic API.
  const isAnthropic = endpoint.provider === "anthropic";
  const envOverrides = isAnthropic
    ? { ANTHROPIC_BASE_URL: endpoint.url, ANTHROPIC_AUTH_TOKEN: token }
    : { OPENAI_BASE_URL: `${endpoint.url}/v1`, OPENAI_API_KEY: token };

  // Codex ignores OPENAI_BASE_URL and, if the user is logged in via ChatGPT,
  // its built-in `openai` provider sends the ChatGPT OAuth JWT as the bearer
  // instead of OPENAI_API_KEY (env_key is None on that provider). That makes
  // Strake 401 the request. Define a custom model provider per-invocation so
  // codex reads OPENAI_API_KEY for auth and routes to the Strake base URL.
  let cmd = rest[0];
  let cmdArgs = rest.slice(1);
  if (cmd === "codex" && !isAnthropic) {
    cmdArgs = [
      "-c", "model_provider=strake",
      "-c", `model_providers.strake.name="Strake"`,
      "-c", `model_providers.strake.base_url="${endpoint.url}/v1"`,
      "-c", `model_providers.strake.env_key="OPENAI_API_KEY"`,
      "-c", `model_providers.strake.wire_api="responses"`,
      "-c", `model_providers.strake.requires_openai_auth=false`,
      ...cmdArgs,
    ];
  }

  const child = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...processEnv, ...envOverrides },
  });

  // Revoke the ephemeral token when the child exits so it doesn't linger in
  // the dashboard. Best-effort — a SIGKILL or machine crash still orphans it.
  let revoked = false;
  const revokeEphemeral = async () => {
    if (revoked || !ephemeralTokenId) return;
    revoked = true;
    try {
      await apiRequest("DELETE", `/endpoints/${subdomain}/tokens/${ephemeralTokenId}`);
    } catch {
      // swallow — user can prune from the dashboard
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { try { child.kill(sig); } catch {} });
  }
  child.on("exit", async (code) => {
    await revokeEphemeral();
    exit(code ?? 0);
  });
}

// ---- help ----

function printHelp() {
  const row = (left, right) => {
    const pad = Math.max(0, 38 - stripAnsi(left).length);
    return `  ${left}${" ".repeat(pad)}${DIM}${right}${RESET}`;
  };

  console.log(`${BOLD}strake${RESET} — Encrypted API key proxy for AI tools
  https://strake.sh

${BOLD}USAGE${RESET}
  strake <group> <command> [options]

${BOLD}AUTH${RESET}
${row("auth login [--token <pat>]",    "Save a personal access token")}
${row("auth logout",                   "Clear local credentials")}
${row("auth whoami",                   "Print the current user's email")}

${BOLD}ENDPOINT${RESET}
${row("endpoint list",                 "List your endpoints")}
${row("endpoint create <provider>",    "Create an endpoint (prompts for key + label)")}
${row("endpoint show <subdomain>",     "Show endpoint details and active tokens")}
${row("endpoint delete <subdomain>",   "Delete an endpoint (irreversible)")}
${row("endpoint rotate-key <sub>",     "Swap the upstream provider key")}
${row("endpoint env <subdomain>",      "Print export lines for shell (needs --token or --mint)")}

${BOLD}TOKEN${RESET}
${row("token add <subdomain>",         "Mint a new bearer token")}
${row("token list <subdomain>",        "List active tokens")}
${row("token revoke <sub> <id>",       "Revoke a token (prompts unless --yes)")}
${row("token rotate <sub> <id>",       "Mint new + revoke old atomically")}

${BOLD}OTHER${RESET}
${row("run <subdomain> -- <cmd>",      "Run a command with Strake env vars injected")}
${row("config show",                   "Show current config (token is masked)")}
${row("config path",                   "Print config file path")}

${BOLD}EXAMPLES${RESET}
  strake auth login
  strake endpoint create openai
  strake endpoint show my-proxy
  strake token add my-proxy --label "cursor"
  strake token list my-proxy
  strake run my-proxy -- python chat.py
  eval "$(strake endpoint env my-proxy --mint)"

${BOLD}FLAGS${RESET}
${row("--json",     "Machine-readable JSON output (read commands)")}
${row("--yes, -y",  "Skip confirmation prompts (destructive actions)")}

${BOLD}ENVIRONMENT${RESET}
${row("STRAKE_TOKEN",     "API token (alternative to auth login)")}
${row("STRAKE_API_BASE",  "Override the API origin (default: https://app.strake.sh)")}
${row("STRAKE_DEBUG",     "Print full error stacks")}
${row("NO_COLOR",         "Disable ANSI colors")}

${BOLD}PROVIDERS${RESET}
  openai | anthropic | gemini | xai | openrouter | custom

${BOLD}CONFIG${RESET}
  ${CONFIG_PATH}

Issues: https://github.com/strakelabs/community`);
}

// ---- config ----

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function saveConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}

async function requireToken() {
  // STRAKE_TOKEN env var takes precedence over the config file (useful in CI).
  if (processEnv.STRAKE_TOKEN) return processEnv.STRAKE_TOKEN;
  const cfg = await loadConfig();
  if (!cfg?.token) {
    throw new Error(`not logged in. Run \`strake auth login\` or set STRAKE_TOKEN.`);
  }
  return cfg.token;
}

// ---- api ----

async function apiRequest(method, path, { token, body } = {}) {
  const t = token || (await requireToken());
  const init = {
    method,
    headers: { Authorization: `Bearer ${t}` },
  };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${API_BASE}/api/v1${path}`, init);
  if (response.status === 204) return null;
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: { message: text } }; }
  if (!response.ok) {
    const msg = parsed?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

// ---- utilities ----

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args[i + 1] ?? null;
}

function providerLabel(p) {
  return {
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    xai: "Grok",
    openrouter: "OpenRouter",
    custom: "Upstream",
  }[p] || p;
}

async function prompt(question, { silent = false } = {}) {
  if (silent && stdin.isTTY) {
    stdout.write(question);
    return new Promise((resolve) => {
      let buf = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (ch) => {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          resolve(buf);
        } else if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          exit(130);
        } else if (ch === "\u007f") {
          if (buf.length > 0) buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function printTable(headers, rows, indent = "") {
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(String(r[i])).length))
  );
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  console.log(indent + headers.map((h, i) => `${DIM}${pad(h, widths[i])}${RESET}`).join("  "));
  for (const r of rows) {
    console.log(indent + r.map((c, i) => pad(String(c), widths[i])).join("  "));
  }
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

main();
