const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const crypto = require("crypto");
const pty = require("node-pty");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.disable("x-powered-by");

const PORT = parseInt(process.env.PORT || "7860", 10);

const SESSIONS_FILE = "/data/sessions.json";
const REPOS_DIR = "/data/repos";

try { fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true }); } catch (_) {}
try { fs.mkdirSync(REPOS_DIR, { recursive: true }); } catch (_) {}

const LOG_RING = [];
const LOG_RING_MAX = 500;

function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `${ts} INFO [hermes-cloud] ${args.join(" ")}`;
  LOG_RING.push(msg);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, 100);
  console.log(msg);
}

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

  const env = { ...process.env, KILO_REMOTE: "1" };
  const cols = 120;
  const rows = 40;

  const ptyProcess = pty.spawn("kilo", [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: workDir,
    env,
  });

  ptyProcess.onData((data) => {
    log(
      `_relay_pty ${logPrefix(label)} raw-chunk len=${Buffer.byteLength(data)} preview=${sanitizeLog(data.slice(0, 200).replace(/\n/g, "\\n"))}`
    );
    const lines = data.split("\n");
    for (const line of lines) {
      const stripped = stripAnsi(line).trim();
      if (stripped) {
        log(`_relay_pty-line ${logPrefix(label)} ${sanitizeLog(stripped.slice(0, 300))}`);
      }
    }
  });

  // Kilo registers with Gateway via KILO_REMOTE=1 + daemon relay + remote_control config.
  // remote_control: true is set in config.json at startup, auto-enabling Cloud Dashboard access.
  log(`_start_kilo_session ${logPrefix(label)} waiting for Kilo to initialize...`);
  await sleep(8000);

  const prompt = "based on readme explain project in 2 lines";
  log(`_start_kilo_session ${logPrefix(label)} sending initial prompt`);
  sendPtyCommand(ptyProcess, prompt, label, "initial-prompt");

  ptyProcess.onExit(({ exitCode }) => {
    log(`_monitor_exit ${logPrefix(label)} kilo exited code=${exitCode}`);
    const sessions = loadSessions();
    for (const s of sessions) {
      if ((s.pid === ptyProcess.pid || s.pid == null) && s.id === label && s.status === "running") {
        s.status = "stopped";
        s.stopped_at = new Date().toISOString();
        s.exit_code = exitCode;
      }
    }
    saveSessions(sessions);
  });

  return ptyProcess.pid;
}

function checkoutRepo(repoUrl, branch, sessionId) {
  const repo = repoName(repoUrl);
  const ws = path.join(REPOS_DIR, `${repo}__${sessionId}`);
  const label = sessionId;

  log(`_checkout_repo ${logPrefix(label)} url=${repoUrl} branch=${branch} dir=${ws}`);

  const url = cloneUrl(repoUrl);
  const cloneResult = execFileSync("git", ["clone", url, ws], {
    timeout: 300000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let resolvedBranch = branch;

  if (branch) {
    try {
      execFileSync("git", ["-C", ws, "checkout", branch], {
        timeout: 30000,
        stdio: "ignore",
      });
    } catch (_) {
      log(`_checkout_repo ${logPrefix(label)} branch '${branch}' not found, creating from default`);
      execFileSync("git", ["-C", ws, "checkout", "-b", branch], {
        timeout: 30000,
        stdio: "ignore",
      });
    }
  } else {
    resolvedBranch = `hermes-${sessionId}`;
    log(`_checkout_repo ${logPrefix(label)} no branch given, creating ${resolvedBranch}`);
    execFileSync("git", ["-C", ws, "checkout", "-b", resolvedBranch], {
      timeout: 30000,
      stdio: "ignore",
    });
  }

  const files = fs.readdirSync(ws);
  log(`_checkout_repo ${logPrefix(label)} entries: ${files.slice(0, 10).join(", ")}`);
  return { workDir: ws, branch: resolvedBranch };
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

      log("_run_device_auth restarting daemon with auth and enabling relay");
      try {
        execFileSync("kilo", ["daemon", "stop"], { timeout: 10000, stdio: "ignore" });
      } catch (_) {}
      await sleep(1000);

      try { fs.mkdirSync("/data/kilo", { recursive: true }); } catch (_) {}
      const daemonLog = fs.openSync("/data/kilo/daemon.log", "a");
      try {
        spawn("kilo", ["daemon", "start", "--foreground"], {
          stdio: ["ignore", daemonLog, daemonLog],
        }).unref();
      } catch (e) {
        log(`_run_device_auth daemon start: ${e.message}`);
      }
      await sleep(3000);

      // Verify daemon is running
      try {
        const ds = execFileSync("kilo", ["daemon", "status", "--json"], {
          encoding: "utf8", timeout: 5000,
        });
        log(`_run_device_auth daemon status: ${ds.trim().slice(0, 200)}`);
      } catch (e) {
        log(`_run_device_auth daemon status check failed: ${e.message}`);
      }

      // Verify Kilo CLI is authenticated (reads auth.json)
      await sleep(2000);
      try {
        const profile = execFileSync("kilo", ["profile", "--json"], {
          encoding: "utf8", timeout: 10000,
        });
        log(`_run_device_auth profile: ${profile.trim().slice(0, 300)}`);
      } catch (e) {
        log(`_run_device_auth profile check failed: ${e.message}`);
      }

      try {
        const remoteLog = fs.openSync("/data/kilo/remote.log", "a");
        const remoteProc = spawn("kilo", ["remote"], {
          stdio: ["ignore", remoteLog, remoteLog],
          env: { ...process.env, KILO_REMOTE: "1" },
        }).unref();
        log("_run_device_auth kilo remote started in background");
        DEVICE_AUTH.message = "Login successful! Gateway relay enabled.";

        // Check remote.log after a moment for connection evidence
        setTimeout(() => {
          try {
            const rl = fs.readFileSync("/data/kilo/remote.log", "utf8");
            const relevant = rl.split("\n").filter(l => /error|fail|connected|relay|gateway|auth/i.test(l));
            if (relevant.length > 0) {
              log(`_run_device_auth remote.log signals: ${relevant.slice(-5).join(" | ").slice(0, 300)}`);
            } else {
              log("_run_device_auth remote.log: no Gateway connection signals yet");
            }
          } catch (_) {}
        }, 5000);
      } catch (e) {
        log(`_run_device_auth kilo remote failed: ${e.message}`);
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
  res.sendFile(path.join(__dirname, "templates", "index.html"));
});

app.get("/api/status", (_req, res) => {
  const result = {
    kilo_version: "unknown",
    kilo_which: null,
    daemon_running: false,
    auth_exists: false,
    repos_dir_exists: fs.existsSync(REPOS_DIR),
    session_count: loadSessions().length,
  };
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
  res.json(result);
});

app.get("/api/logs/daemon", (_req, res) => {
  try {
    const log = fs.readFileSync("/data/kilo/daemon.log", "utf8").slice(-10000);
    const lines = log.split("\n").filter(Boolean).slice(-100);
    res.json({ lines });
  } catch (e) {
    res.json({ lines: [], error: e.message });
  }
});

app.get("/api/logs/remote", (_req, res) => {
  try {
    const log = fs.readFileSync("/data/kilo/remote.log", "utf8").slice(-10000);
    const lines = log.split("\n").filter(Boolean).slice(-100);
    res.json({ lines });
  } catch (e) {
    res.json({ lines: [], error: e.message });
  }
});

app.get("/api/diagnostics", async (_req, res) => {
  const diag = {
    daemon_running: false,
    auth_exists: false,
    auth_type: null,
    profile: null,
    remote_log_lines: [],
    daemon_log_lines: [],
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

app.get("/api/logs", (req, res) => {
  const n = parseInt(req.query.n || "200", 10);
  const lines = LOG_RING.slice(-n);
  res.json({ count: lines.length, lines });
});

app.get("/api/sessions", (_req, res) => {
  const raw = loadSessions();
  const sessions = updateStatus(raw);
  saveSessions(sessions);
  res.json(sessions);
});

app.post("/api/spin-up", async (req, res) => {
  const data = req.body || {};
  const repoUrl = (data.repo_url || "").trim();
  let branch = (data.branch || "").trim() || null;

  if (!repoUrl) {
    return res.status(400).json({ error: "repo_url required" });
  }

  const sessionId = crypto.randomUUID().slice(0, 8);
  const repo = repoName(repoUrl);
  const label = sessionId;
  log(`spin-up session=${label} repo=${repo} branch=${branch}`);

  let workDir, resolvedBranch;
  try {
    const result = checkoutRepo(repoUrl, branch, sessionId);
    workDir = result.workDir;
    resolvedBranch = result.branch;
  } catch (e) {
    return res.status(500).json({ error: "clone failed \u2014 check repo URL and access permissions" });
  }

  let kiloPid;
  try {
    kiloPid = await startKiloSession(workDir, label);
  } catch (e) {
    return res.status(500).json({ error: `session start failed: ${e.message}` });
  }

  const session = {
    id: sessionId,
    repo_url: repoUrl,
    repo_name: repo,
    branch: resolvedBranch,
    work_dir: workDir,
    pid: kiloPid,
    status: "running",
    started_at: new Date().toISOString(),
  };

  const sessions = updateStatus(loadSessions());
  sessions.push(session);
  saveSessions(sessions);
  log(`spin-up ${logPrefix(label)} created id=${sessionId} pid=${kiloPid} branch=${resolvedBranch}`);
  res.status(201).json(session);
});

app.post("/api/kill/:sessionId", (req, res) => {
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

app.post("/api/auth/login", (req, res) => {
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

app.get("/api/auth/status", (_req, res) => {
  res.json({
    status: DEVICE_AUTH.status,
    url: DEVICE_AUTH.url,
    code: DEVICE_AUTH.code,
    message: DEVICE_AUTH.message,
  });
});

app.post("/api/auth/cancel", (_req, res) => {
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

function writeConfigJson() {
  const cfgPath = path.join(KILO_DIR, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) {}
  cfg.remote_control = true;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  log(`_startup_config remote_control=true`);
}

function writeAuthJson() {
  const raw = process.env.KILO_AUTH_TOKEN || "";
  if (!raw) {
    log("_startup_auth KILO_AUTH_TOKEN not set — use web UI device auth");
    return;
  }
  const authPath = path.join(KILO_DIR, "auth.json");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    data = null;
  }
  if (data && typeof data === "object") {
    let kilo = data.kilo || null;
    if (!kilo) {
      if (data.access) {
        kilo = data;
        data = { kilo };
      } else {
        kilo = data;
      }
    }
    if (!kilo.type) {
      if (kilo.access) kilo.type = "oauth";
      else if (kilo.key) kilo.type = "api";
      else { kilo.type = "oauth"; kilo.access = raw; kilo.refresh = raw; }
    }
    if (kilo.type === "oauth" && !kilo.expires) {
      kilo.expires = Date.now() + 365 * 24 * 60 * 60 * 1000;
    }
    data = (data.kilo ? data : { kilo });
  } else {
    data = { kilo: { type: "api", key: raw } };
  }
  fs.writeFileSync(authPath, JSON.stringify(data, null, 2));
  fs.chmodSync(authPath, 0o600);
  const keys = data.kilo ? Object.keys(data.kilo) : Object.keys(data);
  log(`_startup_auth written type=${data.kilo?.type || "?"} keys=${JSON.stringify(keys)}`);
}

async function checkGateway() {
  try {
    const res = await fetch("https://api.kilo.ai/api/profile", { method: "GET", signal: AbortSignal.timeout(5000) });
    log(`_startup_gateway reachable HTTP ${res.status}`);
  } catch (e) {
    if (e.status === 401) {
      log("_startup_gateway reachable HTTP 401 (auth required — expected)");
    } else {
      log(`_startup_gateway UNREACHABLE: ${e.message} — sessions may not appear in Cloud Dashboard`);
    }
  }
}

async function initKiloStartup() {
  try { fs.mkdirSync(KILO_DIR, { recursive: true }); } catch (_) {}
  writeConfigJson();
  writeAuthJson();
  await checkGateway();

  log("_startup starting kilo daemon...");
  const daemonLog = fs.openSync(path.join(KILO_DIR, "daemon.log"), "a");
  try {
    spawn("kilo", ["daemon", "start", "--foreground"], {
      stdio: ["ignore", daemonLog, daemonLog],
    }).unref();
  } catch (e) {
    log(`_startup daemon start failed: ${e.message}`);
  }

  await sleep(3000);

  log("_startup enabling Gateway relay via kilo remote...");
  const remoteLog = fs.openSync(path.join(KILO_DIR, "remote.log"), "a");
  try {
    spawn("kilo", ["remote"], {
      stdio: ["ignore", remoteLog, remoteLog],
      env: { ...process.env, KILO_REMOTE: "1" },
    }).unref();
  } catch (e) {
    log(`_startup kilo remote failed: ${e.message}`);
  }

  const daemonStatusPath = path.join(KILO_DIR, "daemon.log");
  // Brief delay then log relay status from daemon log
  setTimeout(() => {
    try {
      const daemonLog_ = fs.readFileSync(daemonStatusPath, "utf8");
      if (/relay|gateway|remote|connected|websocket|cloud/i.test(daemonLog_)) {
        log("_startup daemon relay: CONNECTED");
      } else {
        log("_startup daemon relay: NOT DETECTED (sessions may not appear in Cloud Dashboard)");
      }
    } catch (_) {}
  }, 5000);

  log("_startup kilo startup complete");
}
