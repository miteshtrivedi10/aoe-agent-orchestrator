---
title: AoE Agent Orchestrator
emoji: 🏛️
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

> **Security status — now hardened.** The `/api/*` surface is split into three
> classes (reads / writes / auth-bootstrap), each tier-gated by a bearer token
> and a per-IP rate limit. `GET /api/status` is intentionally public so you can
> verify the deployment is healthy without credentials. **If you deploy this
> Space publicly you MUST set `HERMES_API_TOKEN` as an environment variable**
> (a secret in HF Spaces). Without it, the server auto-generates an ephemeral
> token on each boot and only the container logs surface it.

## What this Space does

Hermes orchestrates long-running [Kilo CLI](https://kilo.ai) sessions for the
Cloud Dashboard at `https://app.kilo.ai/cloud`. You POST a Git URL, the Space
clones the repo, opens a `kilo` PTY with `KILO_REMOTE=1`, and the Cloud UI can
tail the conversation. Kill and "continue in cloud" round-trip through the same
API.

## API security model

- **Bearer-token auth** — every gated endpoint requires
  `Authorization: Bearer <HERMES_API_TOKEN>`. Compared in constant time
  via `crypto.timingSafeEqual`.
- **Per-IP rate limits** — `express-rate-limit` with `trust proxy: 1` so the
  real client IP (behind HF's reverse proxy) is bucketed, not the proxy.
- **Endpoint classification:**
  | Class | Endpoints | Auth? | Rate limit |
  |---|---|---|---|
  | Public status | `GET /`, `GET /api/status` | no | none |
  | Auth bootstrap | `POST /api/auth/login`, `GET /api/auth/status`, `POST /api/auth/cancel` | no | 20 / hour / IP |
  | Reads | `GET /api/logs`, `/api/logs/daemon`, `/api/logs/remote`, `/api/relay-check`, `/api/diagnostics`, `/api/sessions` | bearer | 60 / min / IP |
  | Writes | `POST /api/spin-up`, `/api/kill/:sessionId`, `/api/sessions/:id/continue` | bearer | 10 / min / IP |
- **Token bootstrap** — if `HERMES_API_TOKEN` is unset, a 48-char hex token is
  generated at boot, logged once via `boot HERMES_API_TOKEN not set …`, and
  available in `/api/logs` (which itself is auth-gated — so only the operator
  with another copy of the token can read it back).
- **Rate-limit escape hatch** — set `HERMES_RATE_LIMIT=off` to disable every
  limiter (use only for automated self-tests).

### Quick verification

```bash
TOKEN="$HERMES_API_TOKEN"

# Public — always reachable
curl -sS https://<space>.hf.space/api/status | jq

# Authenticated read
curl -sS -H "Authorization: Bearer $TOKEN" \
     https://<space>.hf.space/api/sessions | jq

# Authenticated write
curl -sS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"repo_url":"https://github.com/owner/repo.git"}' \
     https://<space>.hf.space/api/spin-up | jq

# Without token — 401
curl -i https://<space>.hf.space/api/sessions
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer realm="hermes-cloud"
```

## Environment variables

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `HERMES_API_TOKEN` | recommended | auto-gen hex | Bearer token for `/api/*` writes + reads |
| `HERMES_RATE_LIMIT` | no | `on` | Set `off` to disable all rate limits |
| `HERMES_DEFAULT_MODEL` | no | `kilo/kilo-auto/free` | Model passed to `kilo run` in `continue` |
| `GITHUB_TOKEN` | no | – | Used to clone private repos on spin-up |
| `KILO_API_KEY` / `KILO_AUTH_TOKEN` | no | – | Server-side Kilo auth (read by `inspectAuth()`) |

## Keeping secrets out of `/api/*`

The Kilo API token in `/data/kilo/auth.json` is never echoed back through
any endpoint. `inspectAuth()` returns metadata (expiry, type, validity)
only — never the literal token. The relay-check probe uses the token to
make the outbound ping but strips it before responding.
