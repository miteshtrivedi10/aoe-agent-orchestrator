---
title: Agent Dock
emoji: 🏛️
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

## What this Space does

Agent Dock is a web UI and REST API that orchestrates [Kilo CLI](https://kilo.ai)
sessions for the Cloud Dashboard at `https://app.kilo.ai/cloud`. Spin up an
interactive PTY session from any Git repo — the session connects to the Cloud
Dashboard via WebSocket relay, so you can send prompts from the Dashboard and
have them executed on the HF Space. Pause, resume, and kill sessions through
the API or the browser-based management UI at `GET /`.

## Quick start

```bash
npm test                # run 99 regression tests
docker build -t agent-dock .
docker run -p 7860:7860 -e AGENT_DOCK_API_TOKEN=... agent-dock
```

## API security model

- **Bearer-token auth** — every gated endpoint requires `Authorization: Bearer <AGENT_DOCK_API_TOKEN>` or `X-Agent-Dock-Token: <AGENT_DOCK_API_TOKEN>`. Compared in constant time via `crypto.timingSafeEqual`.
- **X-Agent-Dock-Token fallback** — for use behind HF private-space proxy, which consumes the `Authorization` header for HF token auth.
- **Per-IP rate limits** — `express-rate-limit` with `trust proxy: 1`.
- **Web UI token injection** — `GET /` embeds the token as `window.__HERMES_TOKEN__`. Only safe while the Space is private.
- **Token bootstrap** — if `AGENT_DOCK_API_TOKEN` is unset, a 48-char hex token is generated at boot (length logged, never the value).
- **Rate-limit escape hatch** — set `AGENT_DOCK_RATE_LIMIT=off` to disable all limiters.

### Endpoint classification

| Class | Endpoint | Auth | Rate limit | Description |
|---|---|---|---|---|
| Public | `GET /` | no | none | Web management UI |
| Public | `GET /api/status` | no | none | Health probe (version, model, auth state, sessions) |
| Auth | `POST /api/auth/login` | no | 20/hr/IP | Start Kilo device-auth flow |
| Auth | `GET /api/auth/status` | no | 20/hr/IP | Poll device-auth state |
| Auth | `POST /api/auth/cancel` | no | 20/hr/IP | Cancel device auth |
| Read | `GET /api/sessions` | bearer | 60/min/IP | List sessions with live process status |
| Read | `GET /api/logs?n=200` | bearer | 60/min/IP | Tail in-memory ring buffer |
| Read | `GET /api/logs/session/:id` | bearer | 60/min/IP | Last 200 lines of a session PTY log (ANSI-stripped) |
| Read | `GET /api/logs/kilo-internal` | bearer | 60/min/IP | Kilo's internal logger files from `/data/kilo/log/` |
| Read | `GET /api/relay-check` | bearer | 60/min/IP | Pre-flight: auth validity + api.kilo.ai + ingest.kilosessions.ai probes |
| Read | `GET /api/diagnostics` | bearer | 60/min/IP | Auth state + internal log scan |
| Write | `POST /api/spin-up` | bearer | 10/min/IP | Clone repo and start a kilo PTY session |
| Write | `POST /api/sessions/:id/pause` | bearer | 10/min/IP | SIGTERM the session, mark paused |
| Write | `POST /api/sessions/:id/resume` | bearer | 10/min/IP | Fork the cloud session with `--cloud-fork` |
| Write | `POST /api/sessions/:id/continue` | bearer | 10/min/IP | Append a prompt to a completed cloud session |
| Write | `POST /api/kill/:sessionId` | bearer | 10/min/IP | Kill session (log + work_dir cleanup) |

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `AGENT_DOCK_API_TOKEN` | auto-gen | Bearer token for gated endpoints |
| `AGENT_DOCK_RATE_LIMIT` | `on` | Set `off` to disable rate limits |
| `AGENT_DOCK_DEFAULT_MODEL` | `kilo/kilo-auto/free` | Model for sessions (set in `kilo.json`) |
| `AGENT_DOCK_SMALL_MODEL` | `kilo/kilo-auto/free` | Model for background tasks (titles, summaries) |
| `AGENT_DOCK_INITIAL_PROMPT` | `based on readme explain project in 2 lines` | Initial prompt sent on spin-up |
| `GITHUB_TOKEN` | – | Used for cloning private repos |
| `KILO_API_KEY` | – | Kilo auth; written to `auth.json` on boot |

## Session lifecycle

**Spin up** — clones repo, spawns `kilo` in a PTY with `KILO_REMOTE=1`. The TUI
auto-enables remote mode via `remote_control: true` in `kilo.json`. An initial
prompt is sent after the remote WebSocket connects, and the cloud session ID
(`ses_...`) is captured from kilo's internal logs. The `/remote` command is
never sent (it is a toggle that would disable remote).

**Pause** — SIGTERMs the process group. Cloud session is preserved.

**Resume** — spawns `kilo run --session <cloud_id> --cloud-fork --share` to
fork the existing cloud session.

**Continue** — runs a new prompt on a completed cloud session via the same fork
mechanism.

**Kill** — permanently terminates the session, cleans up log and work_dir.

## Architecture

No separate `kilo daemon` or `kilo remote` processes. Each PTY session with
`KILO_REMOTE=1` auto-enables its own remote WebSocket to
`wss://ingest.kilosessions.ai`. The TUI manages its own server, ingest HTTP
client, and remote connection internally. Session IDs and ingest breadcrumbs
are read from kilo's internal log files (`/data/kilo/log/*.log`), not from
PTY stdout.

## Keeping secrets out of logs

- `inspectAuth()` returns metadata only — the token field is excluded from all HTTP responses and log output.
- `sanitizeLog()` redacts JWT, Bearer tokens, GitHub tokens, and key/secret patterns before they reach the ring buffer.
- Auto-generated `AGENT_DOCK_API_TOKEN` is never logged; only its length.
- `GITHUB_TOKEN` in clone URLs is stripped from error messages before logging.
- Docker logs and internal kilo logs are verified to contain zero JWT/token patterns.

## Startup sequence

1. Create `/data/kilo`, `/data/repos`, symlink kilo config dirs
2. Kill zombie kilo processes from previous restarts
3. Recover sessions: mark running as paused; remove killed sessions
4. Write `remote_control: true`, default model, and `small_model` to `kilo.json`
5. Write `auth.json` from `KILO_API_KEY` if set and no device-auth exists
6. Probe `api.kilo.ai` and `ingest.kilosessions.ai` reachability
7. Start Express server on port 7860