const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const pty = require("node-pty");
const rateLimit = require("express-rate-limit");

const app = express();
// HF Spaces front the container with a reverse proxy. Trust the first
// hop so per-client rate limits see the real client IP instead of the
// proxy's IP (which would collapse all users into one bucket).
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

const PORT = parseInt(process.env.PORT || "7860", 10);

const SESSIONS_FILE = "/data/sessions.json";
const REPOS_DIR = "/data/repos";

try { fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true }); } catch (_) {}
try { fs.mkdirSync(REPOS_DIR, { recursive: true }); } catch (_) {}

let INDEX_HTML = "";
try { INDEX_HTML = fs.readFileSync(path.join(__dirname, "templates", "index.html"), "utf8"); } catch (_) {}

const LOG_RING = [];
const LOG_RING_MAX = 500;

function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `${ts} INFO [hermes-cloud] ${args.join(" ")}`;
  LOG_RING.push(msg);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, 100);
  console.log(msg);
}

// ── API auth + rate-limit ─────────────────────────────────────────
//
// All /api/* routes EXCEPT the device-auth flow and the public status
// probe require Authorization: Bearer <HERMES_API_TOKEN>. Rate limits
// are layered per route class (read / write / auth-bootstrap).
//
// Env vars:
//   HERMES_API_TOKEN   Set a stable token at deploy time. Recommended.
//                      If unset, one is generated at boot and surfaced
//                      once via the entrypoint log line
//                      `boot HERMES_API_TOKEN not set — ...`.
//   HERMES_RATE_LIMIT  "off" disables every limiter (for self-tests);
//                      otherwise the defaults below apply.

const RAW_TOKEN = (process.env.HERMES_API_TOKEN || "").trim();
const API_TOKEN = RAW_TOKEN || crypto.randomBytes(24).toString("hex");
const TOKEN_IS_AUTOGEN = !RAW_TOKEN;
const RATE_LIMIT_DISABLED = (process.env.HERMES_RATE_LIMIT || "").toLowerCase() === "off";

if (TOKEN_IS_AUTOGEN) {
  log(`boot HERMES_API_TOKEN not set — generated ephemeral token: ${API_TOKEN}`);
} else {
  log(`boot HERMES_API_TOKEN loaded from env (${API_TOKEN.length} chars; auto-gen=${TOKEN_IS_AUTOGEN})`);
}
if (RATE_LIMIT_DISABLED) log("boot HERMES_RATE_LIMIT=off — rate limits disabled (test mode only)");

function authGate(req, res, next) {
  const hdr = req.get("authorization");
  if (!hdr) {
    res.set("WWW-Authenticate", 'Bearer realm="hermes-cloud"');
    return res.status(401).json({
      error: "missing Authorization header",
      hint: "send: Authorization: Bearer <HERMES_API_TOKEN>",
    });
  }
  const m = /^Bearer\s+(.+)$/i.exec(hdr);
  if (!m) {
    res.set("WWW-Authenticate", 'Bearer realm="hermes-cloud"');
    return res.status(401).json({
      error: "Authorization header is not a Bearer token",
      received_scheme: hdr.split(/\s+/)[0],
      hint: "must be: Authorization: Bearer <HERMES_API_TOKEN>",
    });
  }
  const a = Buffer.from(m[1]);
  const b = Buffer.from(API_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "invalid bearer token" });
  }
  next();
}

function makeLimiter(windowMs, max, name) {
  if (RATE_LIMIT_DISABLED) return (_req, _res, next) => next();
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: `rate limit exceeded for ${name}`, window_ms: windowMs },
  });
}

const readLimiter  = makeLimiter(60_000, 60, "read endpoints");
const writeLimiter = makeLimiter(60_000, 10, "write endpoints");
const authLimiter  = makeLimiter(60 * 60_000, 20, "auth endpoints");

function logPrefix(sid) {
  return `[${sid || "?"}]`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch (_) {
    return [];
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function updateStatus(sessions) {
  for (const s of sessions) {
    const pid = s.pid || 0;
    const alive = pid ? isAlive(pid) : false;
    if (alive) {
      s.status = "running";
    } else {
      if (s.status === "running") {
        log(`_update_status pid=${pid} DEAD, marking stopped`);
        s.status = "stopped";
        s.stopped_at = new Date().toISOString();
      }
    }
  }
  return sessions;
}

function cloneUrl(raw) {
  const token = process.env.GITHUB_TOKEN || "";
  if (token && raw.startsWith("https://")) {
    return `https://x-access-token:${token}@${raw.slice(8)}`;
  }
  return raw;
}

function repoName(raw) {
  return raw.replace(/\/$/, "").replace(/\.git$/, "").split("/").pop();
}

function stripAnsi(text) {
  return text.replace(
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b[>=]|\x1b\[\?[0-9;]*[a-zA-Z]|\x1b[NOc78DMEHABCDGJKLMPRSTZ]|\x1b\[[0-9;]*[HfJKMmr]|\x1b[()][AB012]/g,
    ""
  );
}

// Mask secrets in log output before writing to public log stream.
// Catches JWTs, bearer tokens, GitHub tokens, and token/key/secret JSON.
function sanitizeLog(text) {
  return text
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT]")
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-]+(\.[a-zA-Z0-9_\-]+)+/gi, "$1[REDACTED]")
    .replace(/(gh[pousr]_|github_pat_)[a-zA-Z0-9]+/g, "[GITHUB_TOKEN]")
    .replace(/(["':])(token|key|secret|password|access_token|refresh_token)(["':])\s*[:=]\s*["']?[a-zA-Z0-9_\-\.\/+]+/gi, "$1$2$3=[REDACTED]")
    .slice(0, 500);
}

function waitForPrompt(sharedBuf, label, timeoutSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    let seenOffset = 0;
    const check = () => {
      const full = Buffer.concat(sharedBuf).toString("utf8");
      const newData = full.slice(seenOffset);
      if (newData) {
        const decoded = stripAnsi(newData);
        const prompts = [
          "kilo>",
          "\u2502 > ",
          "\u276f ",
          "> ",
          "/remote",
          "How can I help",
          "Type your message",
          "kilo CLI",
          "connected",
        ];
        const matched = prompts.filter((p) => decoded.includes(p));
        if (matched.length > 0) {
          log(
            `_wait_for_prompt ${logPrefix(label)} prompt detected after ${(
              (Date.now() - start) /
              1000
            ).toFixed(1)}s matched=${JSON.stringify(matched)}`
          );
          resolve(true);
          return;
        }
        seenOffset = full.length;
      }
      if (Date.now() - start > timeoutSec * 1000) {
        log(`_wait_for_prompt ${logPrefix(label)} timeout after ${timeoutSec}s`);
        resolve(false);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

function sendPtyCommand(ptyProcess, cmd, label, desc) {
  log(`_send_pty_command ${logPrefix(label)} sending: ${cmd}`);
  try {
    ptyProcess.write(cmd + "\n");
    log(`_send_pty_command ${logPrefix(label)} ${desc} sent (${Buffer.byteLength(cmd + "\n")} bytes)`);
    return true;
  } catch (e) {
    log(`_send_pty_command ${logPrefix(label)} ${desc} WRITE FAILED: ${e.message}`);
    return false;
  }
}

async function startKiloSession(workDir, label) {
  log(`_start_kilo_session ${logPrefix(label)} work_dir=${workDir}`);

  // Pre-flight: surface exactly what AA() inside this session will see.
  // If credentials are missing we tell the user NOW instead of letting them
  // believe the session reached the Cloud Dashboard.
  const authCheck = inspectAuth();
  log(`_start_kilo_session ${logPrefix(label)} auth_check verdict=${authCheck.valid ? "VALID" : "INVALID"} reason=${authCheck.reason}`);

  if (!authCheck.valid) {
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — sessions spawned without valid auth will NOT appear in Cloud Dashboard.`);
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — user must complete /api/auth/login first OR set KILO_API_KEY env`);
  }

  // Spawn `kilo run --share --dangerously-skip-permissions --model <default>:
  //  - --share        → marks the session as cloud-shareable (emits share* bus events)
  //  - --dangerously-skip-permissions → no permission prompts blocking the run
  //  - --model        → use the default model from kilo.json (or env override)
  //  - --print-logs --log-level INFO → so we can verify the relay actually fired
  //
  // This is the ONLY kilo invocation that reliably creates a real session in
  // kilo.db with bus events. Pty TUI invocations render the TUI but never
  // submit a message into a real session, so `kilo remote` never has anything
  // to relay — leaving app.kilo.ai/cloud empty.
  const prompt = process.env.HERMES_INITIAL_PROMPT || "based on readme explain project in 2 lines";
  const model = process.env.HERMES_DEFAULT_MODEL || "kilo/kilo-auto/free";
  const logFile = path.join(KILO_DIR, `session-${label}.log`);

  const args = [
    "run",
    prompt,
    "--dir", workDir,
    "--share",
    "--dangerously-skip-permissions",
    "--model", model,
    "--print-logs",
    "--log-level", "INFO",
  ];

  log(`_start_kilo_session ${logPrefix(label)} running: kilo ${args.join(" ")}`);
  const logFd = fs.openSync(logFile, "a");
  const child = spawn("kilo", args, {
    cwd: workDir,
    env: { ...process.env, KILO_REMOTE: "1" },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  const pid = child.pid;
  log(`_start_kilo_session ${logPrefix(label)} spawned pid=${pid} log=${logFile}`);

  child.on("exit", (code) => {
    log(`_monitor_exit ${logPrefix(label)} kilo run exited code=${code}`);
    // Try to capture the kilo cloud session ID so the user can continue this
    // session from /api/sessions/:id/continue (which uses --session <id> --cloud-fork).
    // NOTE: kilo session list is project-scoped — the per-project kilo.db lives
    // inside the project dir, so the probe must run with cwd=workDir.
    let cloudId = null;
    try {
      const sl = execFileSync("kilo", ["session", "list", "--format", "json", "--max-count", "5"], {
        encoding: "utf8", timeout: 5000, cwd: workDir,
      });
      const sessions = JSON.parse(sl);
      if (Array.isArray(sessions) && sessions.length > 0) {
        const newest = sessions.find((x) => (x.id || x.sessionId || "").startsWith("ses_")) || sessions[0];
        cloudId = newest?.id || newest?.sessionId || null;
      }
    } catch (e) {
      log(`_start_kilo_session ${logPrefix(label)} cloud-id probe failed: ${e.message}`);
    }
    // Fallback: grep the run log for "ses_<id>" — kilo binary sometimes echoes
    // the session id in log lines (we keep both since one of them usually wins).
    if (!cloudId) {
      try {
        const buf = fs.readFileSync(logFile, "utf8");
        const m = buf.match(/ses_[a-z0-9]+/);
        if (m) cloudId = m[0];
      } catch (_) {}
    }
    const sessions = loadSessions();
    for (const s of sessions) {
      if (s.id === label && s.status === "running") {
        s.status = "stopped";
        s.stopped_at = new Date().toISOString();
        s.exit_code = code;
        if (cloudId) {
          s.cloud_session_id = cloudId;
          log(`_monitor_exit ${logPrefix(label)} captured cloud_session_id=${cloudId}`);
        }
      }
    }
    saveSessions(sessions);
  });

  // Give kilo 3s to bootstrap the session and emit bus events so `kilo remote`
  // relays them to ingest.kilosessions.ai before we return the PID.
  // NOTE: kilo session list is project-scoped — must be probed from project cwd.
  await sleep(3000);
  let cloudSessionId = null;
  try {
    const sl = execFileSync("kilo", ["session", "list"], { encoding: "utf8", timeout: 5000, cwd: workDir });
    log(`_start_kilo_session ${logPrefix(label)} session list probe:\n${sl.split("\n").slice(0, 5).join("\n")}`);
    const m = sl.match(/ses_[a-z0-9]+/);
    if (m) {
      cloudSessionId = m[0];
      log(`_start_kilo_session ${logPrefix(label)} captured cloud_session_id=${cloudSessionId}`);
    }
  } catch (e) {
    log(`_start_kilo_session ${logPrefix(label)} session list probe failed: ${e.message}`);
  }

  return { pid, cloudSessionId };
}

function checkoutRepo(repoUrl, branch, sessionId) {
  const repo = repoName(repoUrl);
  const ws = path.join(REPOS_DIR, `${repo}__${sessionId}`);
  const label = sessionId;

  log(`_checkout_repo ${logPrefix(label)} url=${repoUrl} branch=${branch} dir=${ws}`);

  const url = cloneUrl(repoUrl);
  execFileSync("git", ["clone", url, ws], {
    timeout: 300000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Branch is mandatory (already vetted by BRANCH_RE at the route layer).
  // Try the existing branch first; if it doesn't exist locally yet (shallow
  // / no upstream tracking), create it from HEAD so the user's work has a
  // named ref to push to.
  try {
    execFileSync("git", ["-C", ws, "checkout", branch], {
      timeout: 30000,
      stdio: "ignore",
    });
  } catch (_) {
    log(`_checkout_repo ${logPrefix(label)} branch '${branch}' not present, creating from HEAD`);
    execFileSync("git", ["-C", ws, "checkout", "-b", branch], {
      timeout: 30000,
      stdio: "ignore",
    });
  }

  const files = fs.readdirSync(ws);
  log(`_checkout_repo ${logPrefix(label)} entries: ${files.slice(0, 10).join(", ")}`);
  return { workDir: ws, branch };
}

const DEVICE_AUTH = {
  status: "idle",
  url: null,
  code: null,
  message: null,
  ptyProcess: null,
  startedAt: null,
};

async function runDeviceAuth() {
  DEVICE_AUTH.status = "pending";
  DEVICE_AUTH.url = null;
  DEVICE_AUTH.code = null;
  DEVICE_AUTH.message = "Starting Kilo authentication...";
  DEVICE_AUTH.startedAt = Date.now();

  try {
    const ptyProcess = pty.spawn("kilo", ["auth", "login", "-p", "kilo"], {
      name: "xterm-color",
      cols: 120,
      rows: 40,
    });
    DEVICE_AUTH.ptyProcess = ptyProcess;
    log(`_run_device_auth started pid=${ptyProcess.pid}`);

    let buf = "";
    const deadline = Date.now() + 300000;

    const result = await new Promise((resolve) => {
      ptyProcess.onData((data) => {
        buf += data;
        const lines = data.split("\n");
        for (const rawLine of lines) {
          const line = stripAnsi(rawLine).trim();
          if (!line) continue;
          log(`_run_device_auth output: ${sanitizeLog(line.slice(0, 200))}`);

          const urlMatch = line.match(/https:\/\/app\.kilo\.ai\/\S+/);
          if (urlMatch) {
            const url = urlMatch[0].replace(/\u2502/g, "").trim();
            DEVICE_AUTH.url = url;
            DEVICE_AUTH.message = "Open the URL below and enter the code";
            log(`_run_device_auth URL: ${url}`);
          }

          if (/enter code/i.test(line) || /code:/i.test(line)) {
            const codeMatch = line.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
            if (codeMatch) {
              DEVICE_AUTH.code = codeMatch[0];
              log(`_run_device_auth code: ${DEVICE_AUTH.code}`);
            }
          }

          if (
            /login successful/i.test(line) ||
            /done/i.test(line)
          ) {
            DEVICE_AUTH.status = "success";
            DEVICE_AUTH.message = "Login successful!";
            log("_run_device_auth SUCCESS");
          }

          if (/denied/i.test(line) || /expired/i.test(line)) {
            DEVICE_AUTH.status = "failed";
            DEVICE_AUTH.message = `Login failed: ${line}`;
            log(`_run_device_auth FAILED: ${line}`);
          }
        }

        if (Date.now() > deadline) {
          DEVICE_AUTH.status = "failed";
          DEVICE_AUTH.message = "Login timed out (5 minutes)";
          resolve();
        }
      });

      ptyProcess.onExit(({ exitCode }) => {
        if (DEVICE_AUTH.status === "pending") {
          if (exitCode === 0) {
            DEVICE_AUTH.status = "success";
            DEVICE_AUTH.message = "Login successful!";
          } else {
            DEVICE_AUTH.status = "failed";
            DEVICE_AUTH.message = `Login failed (exit ${exitCode})`;
          }
        }
        resolve();
      });
    });

    DEVICE_AUTH.ptyProcess = null;

    if (DEVICE_AUTH.status === "success") {
      // Also check for URL/code from accumulated buffer
      if (!DEVICE_AUTH.url) {
        const urlMatch = buf.match(/https:\/\/app\.kilo\.ai\/\S+/);
        if (urlMatch) DEVICE_AUTH.url = urlMatch[0].replace(/\u2502/g, "").trim();
      }
      if (!DEVICE_AUTH.code) {
        const codeMatch = buf.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        if (codeMatch) DEVICE_AUTH.code = codeMatch[0];
      }

      log("_run_device_auth device-flow login succeeded — server will spawn kilo remote background relay now that auth is valid");
      DEVICE_AUTH.message = "Login successful!";

      // Verify the device-flow actually wrote a parseable auth.json, then
      // spawn the kilo remote background relay so session bus events reach
      // the Cloud Dashboard at app.kilo.ai/cloud.
      await sleep(1000);
      const probe = inspectAuth();
      log(`_run_device_auth auth probe: ${JSON.stringify(probe)}`);
      if (probe.valid) {
        log("_run_device_auth spawning `kilo remote` background relay (now that auth is valid)");
        const remoteLog = fs.openSync(path.join(KILO_DIR, "remote.log"), "a");
        try {
          spawn("kilo", ["remote", "--print-logs"], {
            stdio: ["ignore", remoteLog, remoteLog],
          }).unref();
          log("_run_device_auth kilo remote background relay started (logs: /data/kilo/remote.log)");
        } catch (e) {
          log(`_run_device_auth kilo remote spawn failed: ${e.message}`);
        }
      }
    }

    if (DEVICE_AUTH.status === "pending") {
      DEVICE_AUTH.status = "failed";
      DEVICE_AUTH.message = "Login timed out (5 minutes)";
    }
  } catch (e) {
    log(`_run_device_auth exception: ${e.message}`);
    DEVICE_AUTH.status = "failed";
    DEVICE_AUTH.message = `Error: ${e.message}`;
  }
}

// ── Routes ───────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  if (!INDEX_HTML) return res.status(500).send("index.html unavailable");
  const safe = API_TOKEN.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const html = INDEX_HTML.replace('<script>window.__HERMES_TOKEN__="";</script>', `<script>window.__HERMES_TOKEN__="${safe}";</script>`);
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/api/status", (_req, res) => {
  const result = {
    kilo_version: "unknown",
    kilo_which: null,
    daemon_running: false,
    auth_exists: false,
    repos_dir_exists: fs.existsSync(REPOS_DIR),
    session_count: loadSessions().length,
    default_model: null,
  };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(KILO_DIR, "kilo.json"), "utf8"));
    result.default_model = cfg.model || null;
  } catch (_) {}
  try {
    const out = execFileSync("which", ["kilo"], { encoding: "utf8", timeout: 5000 });
    result.kilo_which = out.trim();
  } catch (_) {}
  try {
    const out = execFileSync("kilo", ["--version"], { encoding: "utf8", timeout: 5000 });
    result.kilo_version = out.trim().slice(0, 100);
  } catch (_) {}
  try {
    const out = execFileSync("kilo", ["daemon", "status"], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (out.includes("running")) result.daemon_running = true;
  } catch (_) {}
  try {
    const st = fs.statSync("/data/kilo/auth.json");
    if (st.size > 10) result.auth_exists = true;
  } catch (_) {}
  res.json({
    ...result,
    api_security: {
      token_required: true,
      token_autogenerated: TOKEN_IS_AUTOGEN,
      token_length: API_TOKEN.length,
      rate_limits: RATE_LIMIT_DISABLED ? "disabled" : {
        read_endpoints:  "60 / min / IP",
        write_endpoints: "10 / min / IP",
        auth_endpoints:  "20 / hour / IP",
      },
      proxy_aware: true,
    },
  });
});

app.get("/api/logs/daemon", authGate, readLimiter, (_req, res) => {
  try {
    const log = fs.readFileSync("/data/kilo/daemon.log", "utf8").slice(-10000);
    const lines = log.split("\n").filter(Boolean).slice(-100);
    res.json({ lines });
  } catch (e) {
    res.json({ lines: [], error: e.message });
  }
});

app.get("/api/logs/remote", authGate, readLimiter, (_req, res) => {
  try {
    const log = fs.readFileSync("/data/kilo/remote.log", "utf8").slice(-10000);
    const lines = log.split("\n").filter(Boolean).slice(-100);
    res.json({ lines });
  } catch (e) {
    res.json({ lines: [], error: e.message });
  }
});

// /api/relay-check — exactly mirrors kilo CLI's AA() pre-flight check so
// the operator can see why a session would or would not reach the Cloud
// Dashboard before they spin one up. Equivalent of:
//   B()  -> read auth.json / KILO_API_KEY
//   M(t) -> verify against api.kilo.ai
//   WS   -> probe wss://ingest.kilosessions.ai
app.get("/api/relay-check", authGate, readLimiter, async (_req, res) => {
  const auth = inspectAuth();

  let apiCheck = { reachable: null, http: null, error: null };
  try {
    const res = await fetch("https://api.kilo.ai/api/profile", {
      method: "GET",
      headers: auth.valid && auth.detected_type !== "env-var"
        ? { "Authorization": `Bearer ${auth.token ?? ""}` }
        : {},
      signal: AbortSignal.timeout(5000),
    });
    apiCheck = { reachable: true, http: res.status, error: null, verified: res.status === 200, auth_invalid: res.status === 401 };
  } catch (e) {
    apiCheck = { reachable: false, http: null, error: e.message };
  }

  let ingestCheck = { reachable: null, http: null, error: null };
  try {
    const res = await fetch("https://ingest.kilosessions.ai", { method: "GET", signal: AbortSignal.timeout(5000) });
    ingestCheck = { reachable: true, http: res.status, error: null };
  } catch (e) {
    ingestCheck = { reachable: false, http: null, error: e.message };
  }

  let generatedConfig = null;
  try {
    const cfgPath = path.join(KILO_DIR, "kilo.json");
    generatedConfig = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (_) {}

  // Reconstruct the kilo binary's verdict so the operator gets a single
  // machine-readable answer instead of having to interpret the pieces.
  let verdict;
  if (!auth.valid)          verdict = `BLOCKED: ${auth.reason}`;
  else if (!apiCheck.reachable) verdict = "BLOCKED: api.kilo.ai unreachable";
  else if (apiCheck.auth_invalid) verdict = "BLOCKED: api.kilo.ai rejected credentials (401) — re-auth required";
  else if (!ingestCheck.reachable) verdict = "BLOCKED: ingest.kilosessions.ai unreachable — relay will fail";
  else                       verdict = "OK: per-PTY session with KILO_REMOTE=1 will appear in Cloud Dashboard";

  res.json({
    verdict,
    auth,
    api: apiCheck,
    ingest: ingestCheck,
    config: {
      primary_path: "/data/kilo/kilo.json",
      primary_contents: generatedConfig,
      legacy_path: "/data/kilo/config.json",
      remote_control: generatedConfig?.remote_control === true,
    },
    endpoints: {
      cloud_dashboard: "https://app.kilo.ai/cloud",
      api:            "https://api.kilo.ai",
      ingest:         "https://ingest.kilosessions.ai",
      websocket:      "wss://ingest.kilosessions.ai",
    },
    env: {
      KILO_API_KEY_set:    !!process.env.KILO_API_KEY,
      KILO_AUTH_TOKEN_set: !!process.env.KILO_AUTH_TOKEN,
      KILO_REMOTE:         process.env.KILO_REMOTE || null,
    },
  });
});

app.get("/api/diagnostics", authGate, readLimiter, async (_req, res) => {
  const diag = {
    daemon_running: false,
    auth_exists: false,
    auth_type: null,
    profile: null,
    remote_log_lines: [],
    daemon_log_lines: [],
    relay: inspectAuth(),
  };
  try {
    const ds = execFileSync("kilo", ["daemon", "status", "--json"], { encoding: "utf8", timeout: 5000 });
    diag.daemon_running = true;
    diag.daemon_status = ds.trim().slice(0, 300);
  } catch (e) { diag.daemon_error = e.message; }
  try {
    const st = fs.statSync("/data/kilo/auth.json");
    if (st.size > 10) diag.auth_exists = true;
    const auth = JSON.parse(fs.readFileSync("/data/kilo/auth.json", "utf8"));
    diag.auth_type = auth?.kilo?.type || null;
  } catch (_) {}
  try {
    const profile = execFileSync("kilo", ["profile", "--json"], { encoding: "utf8", timeout: 10000 });
    diag.profile = JSON.parse(profile);
  } catch (e) { diag.profile_error = e.message; }
  try {
    const rl = fs.readFileSync("/data/kilo/remote.log", "utf8");
    diag.remote_log_lines = rl.split("\n").filter(Boolean).slice(-20);
  } catch (_) {}
  try {
    const dl = fs.readFileSync("/data/kilo/daemon.log", "utf8");
    diag.daemon_log_lines = dl.split("\n").filter(Boolean).slice(-20);
  } catch (_) {}
  res.json(diag);
});

app.get("/api/logs", authGate, readLimiter, (req, res) => {
  const n = parseInt(req.query.n || "200", 10);
  const lines = LOG_RING.slice(-n);
  res.json({ count: lines.length, lines });
});

app.get("/api/sessions", authGate, readLimiter, (_req, res) => {
  const sessions = updateStatus(loadSessions());
  // Best-effort persist; a write failure on a read-only FS shouldn't 500 the GET.
  try { saveSessions(sessions); }
  catch (e) { log(`_persist_sessions write failed (non-fatal): ${e.message}`); }
  res.json(sessions);
});

// repo_url must end in .git (covers https://, git@..., ssh://..., file://...).
// We reject bare web URLs like https://github.com/owner/repo (no .git) so
// pasting a UI link doesn't silently mishandle cloning.
const GIT_URL_RE = /\.git(?:\/?|#.*)?$/i;

// Git ref names: per `git check-ref-format` — no spaces, no `~`, no `^`, no
// `:`, no `?`, no `*`, no `[`, no `\`, no control chars, no leading `-`,
// no `..`, no `@{`, no trailing `.lock`, no backslash. Length 1-255.
// We do NOT touch a shell — branch is passed via execFileSync argv — but
// rejecting weird chars up front stops users from accidentally pasting
// a commit SHA or reflog path.
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,255}$/;

app.post("/api/spin-up", authGate, writeLimiter, async (req, res) => {
  const data = req.body || {};
  const repoUrl = (data.repo_url || "").trim();
  const branch = (data.branch || "").trim();

  if (!repoUrl) {
    return res.status(400).json({ error: "repo_url required" });
  }
  if (!GIT_URL_RE.test(repoUrl)) {
    return res.status(400).json({
      error: "repo_url must end in .git — e.g. https://github.com/owner/repo.git or git@github.com:owner/repo.git",
      received: repoUrl,
    });
  }
  if (!branch) {
    return res.status(400).json({
      error: "branch required — pick the branch you want this session to work on (e.g. 'main')",
    });
  }
  if (!BRANCH_RE.test(branch)) {
    return res.status(400).json({
      error: "branch contains characters git cannot use as a ref name (spaces, ':', '..', '~', '^', etc. are forbidden)",
      received: branch,
    });
  }

  const sessionId = crypto.randomUUID().slice(0, 8);
  const repo = repoName(repoUrl);
  const label = sessionId;
  log(`spin-up session=${label} repo=${repo} branch=${branch}`);

  let workDir;
  try {
    const result = checkoutRepo(repoUrl, branch, sessionId);
    workDir = result.workDir;
  } catch (e) {
    return res.status(500).json({ error: "clone failed \u2014 check repo URL and access permissions" });
  }

  let result;
  try {
    result = await startKiloSession(workDir, label);
  } catch (e) {
    return res.status(500).json({ error: `session start failed: ${e.message}` });
  }
  const { pid: kiloPid, cloudSessionId } = result;

  const session = {
    id: sessionId,
    repo_url: repoUrl,
    repo_name: repo,
    branch,
    work_dir: workDir,
    pid: kiloPid,
    cloud_session_id: cloudSessionId || null,
    status: "running",
    started_at: new Date().toISOString(),
  };

  const sessions = updateStatus(loadSessions());
  sessions.push(session);
  saveSessions(sessions);
  log(`spin-up ${logPrefix(label)} created id=${sessionId} pid=${kiloPid} branch=${branch}`);
  res.status(201).json(session);
});

app.post("/api/kill/:sessionId", authGate, writeLimiter, (req, res) => {
  const sessions = updateStatus(loadSessions());
  for (const s of sessions) {
    if (s.id !== req.params.sessionId) continue;
    const pid = s.pid || 0;
    if (pid && isAlive(pid)) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch (_) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (_) {}
      }
    }
    s.status = "killed";
    s.stopped_at = new Date().toISOString();
    saveSessions(sessions);
    return res.json({ status: "killed", session_id: req.params.sessionId });
  }
  res.status(404).json({ error: "session not found" });
});

// /api/sessions/:id/continue — append a new prompt onto an existing cloud
// session. The Cloud Dashboard at app.kilo.ai/cloud can show past sessions
// but doesn't yet support "Continue in Cloud Agent" (the Kilo UI labels this
// "coming soon"). Until that ships, this endpoint is the server-side
// equivalent of running `kilo --session <id> --cloud-fork` from a terminal.
// It pulls the existing cloud session, runs the new prompt with --share, and
// uploads the new turn back so the Dashboard sees the conversation continue.
app.post("/api/sessions/:id/continue", authGate, writeLimiter, (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  if (!prompt) {
    return res.status(400).json({ error: "prompt required in body" });
  }

  const sessions = loadSessions();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) {
    return res.status(404).json({ error: "session not found" });
  }
  if (!session.cloud_session_id) {
    return res.status(409).json({
      error: "no cloud_session_id captured — original kilo run may still be in progress, or did not complete cleanly",
    });
  }
  if (session.status === "running") {
    return res.status(409).json({ error: "session is still running" });
  }

  const model = process.env.HERMES_DEFAULT_MODEL || "kilo/kilo-auto/free";
  const args = [
    "run",
    prompt,
    "--dir", session.work_dir,
    "--session", session.cloud_session_id,
    "--cloud-fork",
    "--share",
    "--dangerously-skip-permissions",
    "--model", model,
    "--print-logs",
    "--log-level", "INFO",
  ];

  const label = req.params.id;
  const logFile = path.join(KILO_DIR, `session-${label}-cont-${Date.now()}.log`);
  log(`_continue_session ${logPrefix(label)} cloud_id=${session.cloud_session_id} running: kilo ${args.join(" ")}`);
  const logFd = fs.openSync(logFile, "a");
  const child = spawn("kilo", args, {
    cwd: session.work_dir,
    env: { ...process.env, KILO_REMOTE: "1" },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  session.status = "running";
  session.pid = child.pid;
  session.started_at = new Date().toISOString();
  session.last_continue_prompt = prompt.slice(0, 200);
  session.last_continue_log = logFile;
  saveSessions(sessions);

  return res.status(202).json({
    session_id: label,
    cloud_session_id: session.cloud_session_id,
    pid: child.pid,
    log_file: logFile,
    prompt_excerpt: prompt.slice(0, 200),
  });
});

app.post("/api/auth/login", authLimiter, (req, res) => {
  if (DEVICE_AUTH.status === "pending") {
    return res.json({
      status: DEVICE_AUTH.status,
      url: DEVICE_AUTH.url,
      code: DEVICE_AUTH.code,
      message: DEVICE_AUTH.message,
    });
  }
  DEVICE_AUTH.status = "idle";
  DEVICE_AUTH.url = null;
  DEVICE_AUTH.code = null;
  DEVICE_AUTH.message = null;
  runDeviceAuth();

  const pollStart = Date.now();
  while (Date.now() - pollStart < 10000) {
    if (DEVICE_AUTH.url) break;
  }

  res.json({
    status: DEVICE_AUTH.status,
    url: DEVICE_AUTH.url,
    code: DEVICE_AUTH.code,
    message: DEVICE_AUTH.message,
  });
});

app.get("/api/auth/status", authLimiter, (_req, res) => {
  res.json({
    status: DEVICE_AUTH.status,
    url: DEVICE_AUTH.url,
    code: DEVICE_AUTH.code,
    message: DEVICE_AUTH.message,
  });
});

app.post("/api/auth/cancel", authLimiter, (_req, res) => {
  DEVICE_AUTH.status = "cancelled";
  DEVICE_AUTH.message = "Login cancelled";
  if (DEVICE_AUTH.ptyProcess) {
    try {
      DEVICE_AUTH.ptyProcess.kill();
    } catch (_) {}
  }
  DEVICE_AUTH.ptyProcess = null;
  res.json({ status: "cancelled" });
});

app.listen(PORT, "0.0.0.0", () => {
  log(`Server running on http://0.0.0.0:${PORT}`);
  initKiloStartup();
});

// ── Startup Init ─────────────────────────────────────────────────

const KILO_DIR = "/data/kilo";

// Kilo CLI loads config from, in priority order:
//   1. ~/.config/kilo/kilo.json (primary)
//   2. ~/.config/kilo/kilo.jsonc
//   3. ~/.config/kilo/opencode.json (legacy)
//   4. ~/.config/kilo/opencode.jsonc (legacy)
//   5. ~/.config/kilo/config.json (legacy)
// remote_control: true is honored when present in #1, otherwise falls back to legacy files.
// Hermes writes to BOTH so older and newer kilo versions pick it up reliably.
function writeRemoteControlJson() {
  const primary = path.join(KILO_DIR, "kilo.json");
  const legacy  = path.join(KILO_DIR, "config.json");

  for (const cfgPath of [primary, legacy]) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) {}
    cfg.remote_control = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  log(`_startup_config remote_control=true written to kilo.json (primary) and config.json (legacy)`);
}

// Default model — written to kilo.json BEFORE any PTY spawns so the TUI
// opens with this model already selected (avoids "prompt went to wrong model"
// surprises after the first interaction).
// Override at deploy time with HERMES_DEFAULT_MODEL env var.
// Default = kilo/kilo-auto/free (kilo's own free tier — no separate provider
// API key required, billed through the user's kilo credits).
function writeDefaultModel() {
  const model = process.env.HERMES_DEFAULT_MODEL || "kilo/kilo-auto/free";
  const primary = path.join(KILO_DIR, "kilo.json");
  const legacy  = path.join(KILO_DIR, "config.json");

  for (const cfgPath of [primary, legacy]) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) {}
    cfg.model = model;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  log(`_startup_model default model=${model} written to kilo.json (primary) and config.json (legacy)`);
}

// Kilo CLI's auth reader (B() in the binary) checks, in priority order:
//   1. auth.json -> kilo.type === "wellknown" + kilo.token
//   2. auth.json -> kilo.type === "api"      + kilo.key
//   3. auth.json -> kilo.type === "oauth"    + kilo.access
//   4. env var   -> KILO_API_KEY
// Anywhere else (e.g. KILO_AUTH_TOKEN) is ignored by kilo.
// We DO NOT overwrite an existing auth.json produced by `kilo auth login`,
// because device-flow auth has refresh tokens + organization metadata we cannot
// reconstruct from a raw token.
function writeAuthJson() {
  const authPath = path.join(KILO_DIR, "auth.json");

  try {
    const st = fs.statSync(authPath);
    if (st.size > 10) {
      const existing = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const kilo = existing?.kilo;
      if (kilo && (kilo.access || kilo.token || kilo.key)) {
        log(`_startup_auth auth.json already present type=${kilo.type || "?"} — keeping device-flow credentials`);
        return;
      }
    }
  } catch (_) {}

  const raw =
    process.env.KILO_API_KEY ||
    process.env.KILO_AUTH_TOKEN ||  // legacy alias
    "";
  if (!raw) {
    log("_startup_auth no KILO_API_KEY env var and no existing auth.json — use web UI device auth");
    return;
  }

  let data;
  try { data = JSON.parse(raw); } catch (_) { data = null; }

  if (data && typeof data === "object") {
    let kilo = data.kilo || null;
    if (!kilo) {
      if (data.access) { kilo = data; data = { kilo }; }
      else             { kilo = data; }
    }
    if (!kilo.type) {
      if (kilo.access)     kilo.type = "oauth";
      else if (kilo.key)   kilo.type = "api";
      else if (kilo.token) kilo.type = "wellknown";
      else { kilo.type = "wellknown"; kilo.token = raw; }
    }
    if (kilo.type === "oauth" && !kilo.expires) {
      kilo.expires = Date.now() + 365 * 24 * 60 * 60 * 1000;
    }
    data = (data.kilo ? data : { kilo });
  } else {
    data = { kilo: { type: "wellknown", token: raw } };
  }

  fs.writeFileSync(authPath, JSON.stringify(data, null, 2));
  fs.chmodSync(authPath, 0o600);
  const keys = data.kilo ? Object.keys(data.kilo) : Object.keys(data);
  log(`_startup_auth written type=${data.kilo?.type || "?"} keys=${JSON.stringify(keys)} source=KILO_API_KEY env`);
}

// Reflects exactly what kilo CLI's AA() would observe at startup so we can
// fail loudly before letting the user spin up a session that will never
// reach the Cloud Dashboard. Mirrors kilo binary's B() priority order.
function inspectAuth() {
  const authPath = path.join(KILO_DIR, "auth.json");
  let raw = null;
  let st = null;
  try { st = fs.statSync(authPath); raw = fs.readFileSync(authPath, "utf8"); } catch (_) {}
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
  const kilo = parsed?.kilo ?? parsed ?? null;

  let token = null;
  let type = null;
  if (kilo) {
    if (kilo.type === "wellknown" && kilo.token) { token = kilo.token; type = "wellknown"; }
    else if (kilo.type === "api" && kilo.key)   { token = kilo.key;   type = "api"; }
    else if (kilo.type === "oauth" && kilo.access) { token = kilo.access; type = "oauth"; }
    else if (kilo.token)  { token = kilo.token;  type = kilo.type || "wellknown"; }
    else if (kilo.access) { token = kilo.access; type = kilo.type || "oauth"; }
    else if (kilo.key)    { token = kilo.key;    type = kilo.type || "api"; }
  }
  if (!token) {
    const envToken = process.env.KILO_API_KEY || process.env.KILO_AUTH_TOKEN;
    if (envToken) { token = envToken; type = "env-var"; }
  }

  const expires = kilo?.expires ?? null;
  const expired = (typeof expires === "number") && expires < Date.now();

  const result = {
    file_exists: !!st,
    file_size: st?.size ?? 0,
    file_keys: kilo ? Object.keys(kilo) : [],
    configured_type: kilo?.type ?? null,
    detected_type: type,
    has_access: !!(kilo?.access),
    has_refresh: !!(kilo?.refresh),
    has_token: !!(kilo?.token),
    has_key: !!(kilo?.key),
    expires_at: expires ? new Date(expires).toISOString() : null,
    expires_unix_ms: expires ?? null,
    expired,
    valid: !!(token && !expired),
    reason: !token ? "no credentials found (run `kilo auth login` or set KILO_API_KEY)"
            : expired ? "credentials expired"
            : "ok",
  };
  return result;
}

async function checkGateway() {
  try {
    const res = await fetch("https://api.kilo.ai/api/profile", { method: "GET", signal: AbortSignal.timeout(5000) });
    log(`_startup_gateway api.kilo.ai reachable HTTP ${res.status}`);
  } catch (e) {
    if (e.status === 401) {
      log("_startup_gateway api.kilo.ai reachable HTTP 401 (auth required — expected)");
    } else {
      log(`_startup_gateway api.kilo.ai UNREACHABLE: ${e.message}`);
    }
  }
  try {
    const res = await fetch("https://ingest.kilosessions.ai", { method: "GET", signal: AbortSignal.timeout(5000) });
    log(`_startup_gateway ingest.kilosessions.ai reachable HTTP ${res.status}`);
  } catch (e) {
    log(`_startup_gateway ingest.kilosessions.ai UNREACHABLE: ${e.message} — Cloud Dashboard relay will fail`);
  }
}

// initKiloStartup — runs once at server boot.
//
// Cloud Dashboard relay model (verified from kilo CLI v7.3.54 binary):
//
//   kilo TUI (PTY `kilo`) — when started with KILO_REMOTE=1 OR
//   global.remote_control === true, calls AA() which:
//     1) B()   -> read auth.json or KILO_API_KEY env (returns token or null)
//     2) M(t)  -> verify token against api.kilo.ai (returns true|false|undefined)
//     3) WebSocket.connect("wss://ingest.kilosessions.ai", getToken=B, ...)
//     4) P()   -> POST session events to https://ingest.kilosessions.ai
//
//   Each PTY session opens its own relay. A standalone `kilo remote`
//   background process is REDUNDANT and was the cause of much confusion:
//   it created a duplicate anonymous session in the dashboard while the
//   real PTY sessions never reached AA() because auth was missing.
//
// What we do here:
//   1. mkdir /data/kilo
//   2. write remote_control=true to kilo.json (primary) + config.json (legacy)
//   3. write auth.json ONLY if KILO_API_KEY env var is set AND no device auth exists
//   4. probe api.kilo.ai (auth) and ingest.kilosessions.ai (relay)
//   5. start kilo daemon (used for HTTP/SSE endpoints and cross-process session discovery)
//
// We do NOT start a standalone `kilo remote`. Per-PTY sessions enable their own relay.
async function initKiloStartup() {
  try { fs.mkdirSync(KILO_DIR, { recursive: true }); } catch (_) {}
  try { writeRemoteControlJson(); } catch (e) { log(`_startup writeRemoteControlJson failed (non-fatal): ${e.message}`); }
  try { writeDefaultModel();     } catch (e) { log(`_startup writeDefaultModel failed (non-fatal): ${e.message}`); }
  try { writeAuthJson();         } catch (e) { log(`_startup writeAuthJson failed (non-fatal): ${e.message}`); }
  await checkGateway();

  log("_startup starting kilo daemon (HTTP / SSE endpoints + cross-process discover)...");
  let daemonLog;
  try {
    daemonLog = fs.openSync(path.join(KILO_DIR, "daemon.log"), "a");
  } catch (e) {
    log(`_startup cannot open daemon.log (non-fatal): ${e.message} — skipping daemon start`);
    return;
  }
  try {
    spawn("kilo", ["daemon", "start", "--foreground"], {
      stdio: ["ignore", daemonLog, daemonLog],
    }).unref();
  } catch (e) {
    log(`_startup daemon start failed: ${e.message}`);
  }

  await sleep(3000);

  log("_startup checking whether auth.json will allow AA() to succeed...");
  const authCheck = inspectAuth();
  log(`_startup auth_check ${JSON.stringify(authCheck)}`);
  if (authCheck.valid) {
    log(`_startup auth LOCALLY VALID (type=oauth) — spawning kilo remote background relay (subscribes to bus session events)`);
    try {
      const remoteLog = fs.openSync(path.join(KILO_DIR, "remote.log"), "a");
      spawn("kilo", ["remote", "--print-logs"], {
        stdio: ["ignore", remoteLog, remoteLog],
      }).unref();
      log(`_startup kilo remote background relay started (logs: /data/kilo/remote.log)`);
    } catch (e) {
      log(`_startup kilo remote spawn failed (non-fatal): ${e.message}`);
    }
  } else {
    log(`_startup auth LOCALLY INVALID (${authCheck.reason}) — user must complete device auth via /api/auth/login (kilo remote will spawn after login)`);
  }

  log("_startup kilo startup complete");
}
