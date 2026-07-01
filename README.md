---
title: AoE Agent Orchestrator
emoji: 🏛️
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

[![Build and Push to GHCR](https://github.com/miteshtrivedi10/aoe-agent-orchestrator/actions/workflows/docker-build.yml/badge.svg?branch=main)](https://github.com/miteshtrivedi10/aoe-agent-orchestrator/actions/workflows/docker-build.yml)

## What this Space does

Hermes is a web UI and REST API that orchestrates [Kilo CLI](https://kilo.ai)
sessions for the Cloud Dashboard at `https://app.kilo.ai/cloud`. Spin up a
session from any Git repo, kill it, or continue a completed session — all
through the same API. A browser-based management UI is served at `GET /`.

## API security model

- **Bearer-token auth** — every gated endpoint requires
  `Authorization: Bearer <HERMES_API_TOKEN>`. Compared in constant time
  via `crypto.timingSafeEqual`.
- **Per-IP rate limits** — `express-rate-limit` with `trust proxy: 1` so the
  real client IP (behind HF's reverse proxy) is bucketed, not the proxy.
- **Web UI token injection** — `GET /` serves the management dashboard with
  `HERMES_API_TOKEN` embedded as `window.__HERMES_TOKEN__`. The UI's JS
  reads it and attaches the `Authorization` header on every gated fetch.
  This works because the Space is private; making it public would expose
  the token in the HTML source.
- **Token bootstrap** — if `HERMES_API_TOKEN` is unset, a 48-char hex token
  is generated at boot, logged once via `boot HERMES_API_TOKEN not set …`,
  and available in `/api/logs` (which itself is auth-gated).
- **Rate-limit escape hatch** — set `HERMES_RATE_LIMIT=off` to disable every
  limiter (use only for automated self-tests).

### Endpoint classification

| Class | Endpoint | Auth? | Rate limit | Description |
|---|---|---|---|---|
| Public | `GET /` | no | none | Web management UI (token-injected) |
| Public | `GET /api/status` | no | none | Health probe (kilo version, daemon status, auth state, token config) |
| Auth bootstrap | `POST /api/auth/login` | no | 20/hr/IP | Start Kilo device-auth flow; returns URL + code |
| Auth bootstrap | `GET /api/auth/status` | no | 20/hr/IP | Poll current device-auth state |
| Auth bootstrap | `POST /api/auth/cancel` | no | 20/hr/IP | Cancel in-progress device auth |
| Reads | `GET /api/sessions` | bearer | 60/min/IP | List all sessions with live process status |
| Reads | `GET /api/logs?n=200` | bearer | 60/min/IP | Tail in-memory ring buffer of server logs |
| Reads | `GET /api/logs/daemon` | bearer | 60/min/IP | Last 100 lines of `/data/kilo/daemon.log` |
| Reads | `GET /api/logs/remote` | bearer | 60/min/IP | Last 100 lines of `/data/kilo/remote.log` |
| Reads | `GET /api/relay-check` | bearer | 60/min/IP | Pre-flight: mirrors kilo CLI's AA() auth check + probes api.kilo.ai and ingest.kilosessions.ai |
| Reads | `GET /api/diagnostics` | bearer | 60/min/IP | Full diagnostics (daemon status, auth, profile, recent logs) |
| Writes | `POST /api/spin-up` | bearer | 10/min/IP | Clone a repo and start a kilo session |
| Writes | `POST /api/kill/:sessionId` | bearer | 10/min/IP | SIGTERM the session's process group |
| Writes | `POST /api/sessions/:id/continue` | bearer | 10/min/IP | Append a prompt to a completed cloud session via `--cloud-fork` |

### Quick verification

```bash
TOKEN="$HERMES_API_TOKEN"
SP=https://<space>.hf.space

# Public — always reachable
curl -sS $SP/api/status | jq

# Device auth — start login flow
curl -sS -X POST $SP/api/auth/login | jq

# Poll auth status
curl -sS $SP/api/auth/status | jq

# Authenticated reads
curl -sS -H "Authorization: Bearer $TOKEN" $SP/api/sessions | jq
curl -sS -H "Authorization: Bearer $TOKEN" "$SP/api/logs?n=10" | jq
curl -sS -H "Authorization: Bearer $TOKEN" $SP/api/relay-check | jq
curl -sS -H "Authorization: Bearer $TOKEN" $SP/api/diagnostics | jq

# Spin up a session
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo_url":"https://github.com/owner/repo.git","branch":"main"}' \
  $SP/api/spin-up | jq

# Kill a session
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  $SP/api/kill/<sessionId> | jq

# Continue a completed session (requires cloud_session_id from spin-up response)
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"explain the project structure"}' \
  $SP/api/sessions/<id>/continue | jq

# Without token — 401
curl -i $SP/api/sessions
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer realm="hermes-cloud"
```

## Environment variables

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `HERMES_API_TOKEN` | recommended | auto-gen 48-char hex | Bearer token for `/api/*` writes + reads; injected into web UI |
| `HERMES_RATE_LIMIT` | no | `on` | Set `off` to disable all rate limits |
| `HERMES_DEFAULT_MODEL` | no | `kilo/kilo-auto/free` | Model for `kilo run` (spin-up + continue) |
| `HERMES_INITIAL_PROMPT` | no | `based on readme explain project in 2 lines` | Prompt sent to `kilo run` on spin-up |
| `GITHUB_TOKEN` | no | – | Used to clone private repos on spin-up |
| `KILO_API_KEY` | no | – | Server-side Kilo auth; written to `auth.json` on boot |
| `KILO_AUTH_TOKEN` | no | – | Legacy alias for `KILO_API_KEY` |

## Session lifecycle

### Spin up (`POST /api/spin-up`)

Clones the repo into `/data/repos/<name>__<sessionId>/`, checks out the
branch, and spawns `kilo run --share --dangerously-skip-permissions
--model <model> --dir <workdir>`. The cloud session ID is captured from
the `kilo session list` probe immediately after startup and stored in
the session record.

**Request validation:**

| Field | Rule |
|---|---|
| `repo_url` | must end with `.git` (covers `https://`, `git@…:`, `ssh://`, `file://`); bare web URLs like `https://github.com/owner/repo` (no `.git`) are rejected |
| `branch` | non-empty; must match `git check-ref-format` — no spaces, no `:`, no `..`, no leading `-`, no `@{`, no trailing `.lock`, no control chars, length 1–255 |

Returns `201` with the session object including `cloud_session_id`.

### Kill (`POST /api/kill/:sessionId`)

Sends `SIGTERM` to the session's process group (or process if group kill
fails). Marks the session as `killed`. Returns `200` on success, `404` if
the session ID is not found.

### Continue (`POST /api/sessions/:id/continue`)

Runs a new prompt on a completed cloud session via `kilo run --session
<cloud_session_id> --cloud-fork --share`. Requires `cloud_session_id`
to be present in the session record (captured at spin-up or during exit).
The session must have status `stopped` or `killed`; running sessions
return `409`.

Body: `{"prompt": "your follow-up prompt"}`

## Device auth flow

The web UI at `GET /` detects whether Kilo gateway credentials are
present and shows a login card if not. The flow:

1. `POST /api/auth/login` spawns `kilo auth login -p kilo` in a PTY
2. The PTY output is parsed for the device-auth URL and code
3. The UI polls `GET /api/auth/status` every 3 seconds
4. On success, the server spawns a `kilo remote` background relay and
   the UI reloads

## Relay architecture

Each kilo session spawned with `KILO_REMOTE=1` opens its own WebSocket
relay to `wss://ingest.kilosessions.ai`. The `kilo remote` background
process subscribes to bus session events so the Cloud Dashboard at
`app.kilo.ai/cloud` sees sessions in real time.

`GET /api/relay-check` mirrors kilo CLI's `AA()` pre-flight:
- Reads `auth.json` / `KILO_API_KEY` (same priority as kilo binary)
- Probes `https://api.kilo.ai/api/profile` for credential validity
- Probes `https://ingest.kilosessions.ai` for relay reachability
- Returns a single `verdict` field (`OK` or `BLOCKED: <reason>`)

## Keeping secrets out of `/api/*`

The Kilo API token in `/data/kilo/auth.json` is never echoed back through
any endpoint. `inspectAuth()` returns metadata (expiry, type, validity)
only — never the literal token. The relay-check probe uses the token to
make the outbound ping but strips it before responding. Server logs are
sanitized with `sanitizeLog()` before they reach the ring buffer.

## Startup sequence

On container boot (`entrypoint.sh` → `node server.js`):

1. Create `/data/kilo`, `/data/repos`, symlink kilo config dirs
2. Write `remote_control: true` and default model to `kilo.json`
3. Write `auth.json` from `KILO_API_KEY` env var if set and no
   device-auth credentials exist
4. Probe `api.kilo.ai` and `ingest.kilosessions.ai` reachability
5. Start `kilo daemon` (HTTP/SSE + cross-process session discovery)
6. If auth is locally valid, spawn `kilo remote` background relay
7. Start Express server on port 7860