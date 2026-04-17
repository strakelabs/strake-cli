# strake

The official CLI for [Strake](https://strake.sh) — a vault that stands between your real API keys and every AI tool you hand them to.

## Install

```sh
npm install -g strake
```

Node 18 or newer.

## Get started

1. Mint a personal access token in the dashboard: [app.strake.sh/dashboard/settings](https://app.strake.sh/dashboard/settings) → **Access tokens** → **Create**.
2. Log in locally:

   ```sh
   strake login --token pat_...
   ```

3. Connect a provider:

   ```sh
   strake connect openai
   ```

   You'll be prompted for the upstream API key. Strake issues you back a Strake endpoint URL and a disposable bearer token.

## Everyday use

```sh
strake endpoints                       # list everything
strake get abc123                      # show one endpoint + its tokens
strake run abc123 -- cursor            # launch cursor with OPENAI_BASE_URL and OPENAI_API_KEY pre-set
eval "$(strake env abc123 --mint)"     # set the env vars in your current shell
strake tokens add abc123 --label "CI"  # issue a new bearer token
strake tokens revoke abc123 ctok_...   # revoke one
strake delete abc123                   # remove the endpoint entirely
```

Run `strake help` for the full command list.

## Environment

- `STRAKE_API_BASE` — override the API origin (default `https://app.strake.sh`)
- `STRAKE_DEBUG` — set anything to see full error stacks

## Storage

Credentials live in `~/.config/strake/config.json` with mode `0600`. `strake logout` empties it.

## Bugs & feature requests

Open one at [github.com/strakelabs/community](https://github.com/strakelabs/community). For private security reports, email [security@strakelabs.com](mailto:security@strakelabs.com).

---

Strake is operated by Dalton Solutions, LLC.
