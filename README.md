# @strakelabs/strake

The official CLI for [Strake](https://strake.sh) — a vault that stands between your real API keys and every AI tool you hand them to.

The point of the CLI: never paste your Strake URL or a bearer token into a tool's config again. You give `strake` a subdomain, it gives the tool a live, scoped, auto-rotated endpoint.

## Install

```sh
npm install -g @strakelabs/strake
```

Node 18 or newer. The installed command is `strake` (the scoped package name is just for npm).

## One-time setup

```sh
# 1. Mint a Personal Access Token
open https://app.strake.sh/dashboard/settings
# → Access tokens → Create → copy the pat_... it shows once

# 2. Log the CLI in
strake login --token pat_...
# → "Logged in as you@example.com."
```

Credentials land in `~/.config/strake/config.json` (mode `0600`). `strake logout` clears them.

---

## Create your first endpoint

```sh
strake connect openai
# Label (optional) [e.g. Cursor]: Cursor on laptop
# OpenAI API key: <paste sk-... — input is hidden>
#
# Endpoint created.
#   URL:   https://abc123def456.strake.sh
#   Token: 5656d21667545a...  ← shown once, save it now
```

`strake connect` works for `openai`, `anthropic`, `gemini`, `xai`, `openrouter`, or `custom`. For built-in providers, the CLI validates the key against the provider *before* the endpoint is created, so a typo fails fast.

List, inspect, delete:

```sh
strake endpoints                       # table of everything
strake get abc123def456                # one endpoint + its tokens
strake delete abc123def456             # irreversible (prompts for confirmation)
```

---

## Use an endpoint with your AI tool

This is where the CLI earns its keep. Two patterns:

### Pattern A: `strake run` (recommended)

```sh
strake run abc123def456 -- claude
```

What happens:

1. `strake` mints a short-lived bearer token for the endpoint.
2. It spawns `claude` as a subprocess with these environment variables set:
   - `OPENAI_BASE_URL=https://abc123def456.strake.sh/v1`
   - `OPENAI_API_KEY=<the-fresh-token>`
   - `ANTHROPIC_BASE_URL=https://abc123def456.strake.sh`
   - `ANTHROPIC_AUTH_TOKEN=<the-fresh-token>`
3. Claude Code picks up `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` and routes every request through Strake. The vault injects your real Anthropic key and forwards upstream. Your real key never touches Claude Code.

Works the same way with anything that honors those env names:

```sh
strake run abc123def456 -- cursor            # Cursor (OpenAI-compatible base URL override)
strake run abc123def456 -- python app.py     # any OpenAI SDK / Anthropic SDK script
strake run abc123def456 -- npm run dev       # a Next.js app using OpenAI SDK
strake run abc123def456 -- code .            # VS Code + Copilot Chat BYOK
```

The spawned process exits, the CLI exits, the minted token is still valid but can be revoked (`strake get` shows every active token; `strake tokens revoke <sub> <id>` kills one).

### Pattern B: `strake env` for your current shell

When you want Strake vars in *your* shell — for curl-ing, writing quick scripts, or composing with other tools — use `eval`:

```sh
eval "$(strake env abc123def456 --mint)"

echo $OPENAI_BASE_URL
# https://abc123def456.strake.sh/v1

curl "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

`--mint` tells the CLI to issue a fresh bearer on the fly. Alternatively, pass `--token <plaintext>` to reuse a token you already have.

Note: `strake env` prints `OPENAI_*` vars by default — OpenAI's env names are a near-universal standard. If your tool looks for different names, set them yourself from the same token + URL.

---

## Managing tokens

Every endpoint can have any number of labeled bearer tokens. You can give each tool its own and revoke one without touching the others.

```sh
strake tokens add abc123def456 --label "CI pipeline"
# → prints the plaintext once, copy it into your CI secrets

strake tokens revoke abc123def456 ctok_abc123
# → done. That token 401s on the very next request.
```

Lost a token? `strake tokens add` issues a new one; revoke the old label-mate with `strake tokens revoke`. The endpoint URL and the real upstream key never change.

Or do both in one step:

```sh
strake tokens rotate abc123def456 ctok_old --label "Cursor (rotated)"
# → prints the new plaintext once, revokes ctok_old.
```

---

## Rotate the upstream provider key

When OpenAI, Anthropic, or another provider rotates *your* real API key, paste the new one without touching the Strake URL or any downstream tooling:

```sh
strake rotate-key abc123def456
# → prompts for the new key (input hidden), validates against the provider,
#   re-encrypts and swaps it in. Next request uses the new key automatically.
```

---

## Command reference

| Command | Description |
| --- | --- |
| `strake login --token <pat>` | Save a personal access token locally. |
| `strake logout` | Remove local credentials. |
| `strake whoami` | Print the email tied to the current PAT. |
| `strake endpoints` (or `list`) | Table of every endpoint on your account. |
| `strake connect <provider>` | Create an endpoint. Prompts for the upstream key and a label. |
| `strake get <subdomain>` | Show endpoint metadata + every token issued for it. |
| `strake env <subdomain> [--mint\|--token X]` | Print export lines for the current shell. |
| `strake run <subdomain> -- <cmd...>` | Run `<cmd>` with `OPENAI_*` and `ANTHROPIC_*` env vars set. Mints a token on the fly. |
| `strake tokens add <subdomain> [--label X]` | Mint a new bearer token (shown once). |
| `strake tokens revoke <subdomain> <token-id>` | Revoke a single token. |
| `strake tokens rotate <subdomain> <token-id> [--label X]` | Mint a new token **and** revoke the old one in one command. |
| `strake rotate-key <subdomain>` | Paste a new upstream provider key. Strake URL + bearer tokens stay the same. |
| `strake delete <subdomain>` | Irreversibly delete an endpoint. |
| `strake help` | Full help. |
| `strake --version` | Print the installed version. |

---

## Environment

- `STRAKE_API_BASE` — override the management API origin (default `https://app.strake.sh`).
- `STRAKE_DEBUG=1` — print full error stacks.

## Storage

`~/.config/strake/config.json`, mode `0600`, owned by your user. Shape:

```json
{
  "token": "pat_...",
  "email": "you@example.com",
  "api_base": "https://app.strake.sh"
}
```

## Bugs & feature requests

Open one at [github.com/strakelabs/community](https://github.com/strakelabs/community). For private security reports, email [security@strakelabs.com](mailto:security@strakelabs.com).

---

Strake is operated by Dalton Solutions, LLC.
