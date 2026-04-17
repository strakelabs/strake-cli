#!/usr/bin/env node
// Strake CLI — tiny zero-dep client for app.strake.sh/api/v1.
//
// Handwritten command dispatch + prompts to keep the install footprint to
// literally one file. Node 18+ gives us fetch, readline/promises, and os.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, exit, argv, env as processEnv } from "node:process";

const API_BASE = processEnv.STRAKE_API_BASE || "https://app.strake.sh";
const CONFIG_DIR = join(homedir(), ".config", "strake");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

async function main() {
  const [, , command, ...args] = argv;
  try {
    switch (command) {
      case "login": return await login(args);
      case "logout": return await logout();
      case "whoami": return await whoami();
      case "endpoints":
      case "list": return await listEndpoints();
      case "connect": return await connect(args);
      case "get": return await getEndpoint(args);
      case "env": return await envCmd(args);
      case "run": return await run(args);
      case "tokens": return await tokensCmd(args);
      case "rotate-key": return await rotateUpstreamKey(args);
      case "delete":
      case "revoke": return await deleteEndpoint(args);
      case "help":
      case "--help":
      case "-h":
      case undefined: return printHelp();
      case "version":
      case "--version":
      case "-v": {
        const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
        console.log(pkg.version);
        return;
      }
      default:
        console.error(`${RED}Unknown command:${RESET} ${command}`);
        printHelp();
        exit(1);
    }
  } catch (err) {
    console.error(`${RED}error:${RESET} ${err.message}`);
    if (processEnv.STRAKE_DEBUG) console.error(err);
    exit(1);
  }
}

function printHelp() {
  console.log(`${BOLD}strake${RESET} — CLI for https://strake.sh

${BOLD}USAGE${RESET}
  strake <command> [options]

${BOLD}COMMANDS${RESET}
  login [--token <pat>]          Save a personal access token. If --token is
                                 omitted you'll be prompted.
  logout                         Delete local credentials.
  whoami                         Print the user the token belongs to.

  endpoints                      List your endpoints.
  connect <provider>             Create an endpoint. Prompts for the key and a label.
                                 provider: openai | anthropic | gemini | xai | openrouter | custom
  get <subdomain>                Show an endpoint's details + its tokens.
  delete <subdomain>             Delete an endpoint (irreversible).

  env <subdomain>                Print export lines for OPENAI_BASE_URL +
                                 OPENAI_API_KEY. Requires a token for the
                                 endpoint, either via --token or a new one
                                 issued on the fly (opt in with --mint).
  run <subdomain> -- <cmd...>    Run <cmd> with Strake env vars set.

  tokens add <subdomain> [--label]   Mint a new bearer token for an endpoint.
  tokens revoke <subdomain> <id>     Revoke one.
  tokens rotate <subdomain> <id> [--label]
                                  Mint a new token + revoke the old one in
                                  a single command. Returns the new plaintext.

  rotate-key <subdomain>          Paste a new upstream provider key.
                                  Strake URL + bearer tokens stay the same.

${BOLD}ENVIRONMENT${RESET}
  STRAKE_API_BASE   Override the API origin (default: https://app.strake.sh)
  STRAKE_DEBUG      Set to see full error stacks.

${BOLD}CONFIG${RESET}
  ${CONFIG_PATH}

Issues or feature requests: https://github.com/strakelabs/community`);
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
  const cfg = await loadConfig();
  if (!cfg?.token) {
    throw new Error(`not logged in. Mint a token at ${API_BASE}/dashboard/settings and run \`strake login --token …\``);
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

// ---- commands ----

async function login(args) {
  let token = flag(args, "--token");
  if (!token) {
    console.log(`Mint a personal access token at ${BOLD}${API_BASE}/dashboard/settings${RESET}, then paste it below.`);
    token = (await prompt("Token: ", { silent: true })).trim();
  }
  if (!token) throw new Error("no token provided");
  // Validate with /me
  const me = await apiRequest("GET", "/me", { token });
  await saveConfig({ token, email: me.user.email, api_base: API_BASE });
  console.log(`${GREEN}Logged in as${RESET} ${me.user.email}.`);
}

async function logout() {
  if (!existsSync(CONFIG_PATH)) {
    console.log("Not logged in.");
    return;
  }
  await writeFile(CONFIG_PATH, "{}\n", { mode: 0o600 });
  console.log("Logged out.");
}

async function whoami() {
  const me = await apiRequest("GET", "/me");
  console.log(me.user.email);
}

async function listEndpoints() {
  const { endpoints } = await apiRequest("GET", "/endpoints");
  if (endpoints.length === 0) {
    console.log(`${DIM}(no endpoints yet — try \`strake connect openai\`)${RESET}`);
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

async function connect(args) {
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

async function getEndpoint(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("subdomain required");
  const { endpoint, tokens } = await apiRequest("GET", `/endpoints/${subdomain}`);
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
    const rows = active.map((t) => [t.id, t.label, t.preview ?? "—", new Date(t.created_at).toISOString().slice(0, 10)]);
    printTable(["ID", "LABEL", "PREVIEW", "CREATED"], rows, "  ");
  }
}

async function envCmd(args) {
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
  // OpenAI-shaped env vars are the most widely supported. Users on Anthropic-
  // SDK flows should pass --provider, but for v1 we stick with the defaults.
  console.log(`export OPENAI_BASE_URL="${endpoint.url}/v1"`);
  console.log(`export OPENAI_API_KEY="${token}"`);
}

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
  if (!token) {
    const { token: t } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
      body: { label: `strake-cli run ${rest[0]}` },
    });
    token = t.plaintext;
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
  child.on("exit", (code) => exit(code ?? 0));
}

async function tokensCmd(args) {
  const sub = args[0];
  switch (sub) {
    case "add": {
      const subdomain = args[1];
      if (!subdomain) throw new Error("usage: strake tokens add <subdomain> [--label <label>]");
      const label = flag(args, "--label");
      const { token } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
        body: label ? { label } : {},
      });
      console.log(`\n${GREEN}Token created.${RESET} ${DIM}(shown once)${RESET}\n`);
      console.log(`  ${BOLD}${token.plaintext}${RESET}`);
      return;
    }
    case "revoke": {
      const subdomain = args[1];
      const id = args[2];
      if (!subdomain || !id) throw new Error("usage: strake tokens revoke <subdomain> <token-id>");
      await apiRequest("DELETE", `/endpoints/${subdomain}/tokens/${id}`);
      console.log(`${GREEN}Revoked.${RESET}`);
      return;
    }
    case "rotate": {
      const subdomain = args[1];
      const oldId = args[2];
      if (!subdomain || !oldId) throw new Error("usage: strake tokens rotate <subdomain> <old-token-id> [--label <label>]");
      const label = flag(args, "--label");
      const { token } = await apiRequest("POST", `/endpoints/${subdomain}/tokens`, {
        body: label ? { label } : {},
      });
      try {
        await apiRequest("DELETE", `/endpoints/${subdomain}/tokens/${oldId}`);
      } catch (err) {
        console.error(`${YELLOW}warn:${RESET} minted the new token but failed to revoke ${oldId} (${err.message}). You can revoke it manually later.`);
      }
      console.log(`\n${GREEN}Rotated.${RESET} ${DIM}(new token shown once)${RESET}\n`);
      console.log(`  ${BOLD}${token.plaintext}${RESET}`);
      return;
    }
    default:
      throw new Error("usage: strake tokens <add|revoke|rotate> …");
  }
}

async function rotateUpstreamKey(args) {
  const subdomain = args[0];
  if (!subdomain) throw new Error("usage: strake rotate-key <subdomain>");
  const { endpoint } = await apiRequest("GET", `/endpoints/${subdomain}`);
  console.log(`Rotating upstream ${providerLabel(endpoint.provider)} key on ${BOLD}${subdomain}${RESET}.`);
  console.log(`${DIM}Strake URL and bearer tokens stay the same.${RESET}`);
  const apiKey = (await prompt(`New ${providerLabel(endpoint.provider)} API key: `, { silent: true })).trim();
  if (!apiKey) throw new Error("api key required");
  await apiRequest("POST", `/endpoints/${subdomain}/credential/rotate`, { body: { api_key: apiKey } });
  console.log(`${GREEN}Rotated.${RESET} The next request will use the new upstream key.`);
}

async function deleteEndpoint(args) {
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
    // Poor-man's silent read — readline doesn't support it natively. We mute
    // the terminal's own echo for the duration of the answer.
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
