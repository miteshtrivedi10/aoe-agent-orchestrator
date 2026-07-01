const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { log, logPrefix, stripAnsi, sleep, waitForString } = require("./logger");
const { KILO_DIR, inspectAuth, writeAuthJson } = require("./auth");
const { loadSessions, saveSessions } = require("./sessions");

// Registry of live TUI PTYs keyed by session label. Holding the reference keeps
// the interactive TUI (and its connected remote WebSocket to the Cloud
// Dashboard) alive, so prompts sent from the dashboard are executed here in the
// container. Also lets us write prompts directly into the live session.
const LIVE_PTYS = new Map();

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

function writeDefaultModel() {
  const model = process.env.HERMES_DEFAULT_MODEL || "kilo/kilo-auto/free";
  // Background tasks (session titles, context summarization) use `small_model`.
  // If unset, kilo falls back to google/gemini-3-flash-preview which needs a
  // Google credential we don't have -> 401 UNAUTHENTICATED synced into the
  // cloud session. Pin it to the kilo free tier so everything stays on the
  // authenticated kilo gateway.
  const smallModel = process.env.HERMES_SMALL_MODEL || "kilo/kilo-auto/free";
  const primary = path.join(KILO_DIR, "kilo.json");
  const legacy  = path.join(KILO_DIR, "config.json");

  for (const cfgPath of [primary, legacy]) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) {}
    cfg.model = model;
    cfg.small_model = smallModel;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  log(`_startup_model default model=${model} small_model=${smallModel} written to kilo.json (primary) and config.json (legacy)`);
}

// The cloud session ID (ses_...) and ingest/remote breadcrumbs are written to
// kilo's INTERNAL logger (Path.log = ~/.local/share/kilo/log/<ISO>.log, which
// the container symlinks to /data/kilo/log). They are NOT emitted to the TUI's
// stdout/PTY, so scraping the PTY buffer never works. This reads the internal
// log files modified after `sinceMs` and extracts the session ID + confirms the
// ingest flush actually reached ingest.kilosessions.ai.
function scanInternalLogs(sinceMs) {
  const logDir = path.join(KILO_DIR, "log");
  const result = { cloudSessionId: null, ingestFlushed: false, remoteConnected: false, remoteEnabled: false, sessionCreated: false, files: [] };
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const full = path.join(logDir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
        return { full, mtime };
      })
      .filter((x) => x.mtime >= sinceMs - 2000) // small skew allowance
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_) { return result; }

  for (const { full } of files) {
    let content = "";
    try { content = fs.readFileSync(full, "utf8"); } catch (_) { continue; }
    result.files.push(full);
    if (!result.cloudSessionId) {
      // Prefer the kilo-sessions service lines (the real ingested session),
      // fall back to any ses_ token. Exclude title-ses_ prefixed IDs.
      const m = content.match(/service=kilo-sessions\s+sessionId=(ses_[a-zA-Z0-9]+)/)
             || content.match(/session\.id=(ses_[a-zA-Z0-9]+)/)
             || content.match(/(ses_[a-zA-Z0-9]+)/);
      if (m) result.cloudSessionId = m[1];
    }
    if (/ingest\.kilosessions\.ai\/api\/session\/.*\/ingest.*ingest flush/.test(content)
        || /types=[^ ]*session[^ ]*.*ingest flush/.test(content)) {
      result.ingestFlushed = true;
    }
    if (/remote-ws connected/.test(content)) result.remoteConnected = true;
    if (/remote-status-changed|enableRemote|remote_control/.test(content)) result.remoteEnabled = true;
    // A session is only created once a prompt is actually submitted. This is the
    // signal that our prompt-injection worked and something will ingest.
    if (/type=session\.created publishing|creating session|session\.turn\.open publishing/.test(content)) {
      result.sessionCreated = true;
    }
  }
  return result;
}

async function checkGateway() {
  try {
    const res = await fetch("https://api.kilo.ai/api/profile", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    log(`_startup_gateway api.kilo.ai reachable HTTP ${res.status}`);
    if (res.status === 401) {
      log("_startup_gateway api.kilo.ai reachable HTTP 401 (auth required — expected)");
    }
  } catch (e) {
    log(`_startup_gateway api.kilo.ai UNREACHABLE: ${e.message}`);
  }

  try {
    const res = await fetch("https://ingest.kilosessions.ai", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    log(`_startup_gateway ingest.kilosessions.ai reachable HTTP ${res.status}`);
  } catch (e) {
    log(`_startup_gateway ingest.kilosessions.ai UNREACHABLE: ${e.message} — Cloud Dashboard relay will fail`);
  }
}

async function startKiloSession(workDir, label) {
  log(`_start_kilo_session ${logPrefix(label)} work_dir=${workDir}`);

  const authCheck = inspectAuth();
  log(`_start_kilo_session ${logPrefix(label)} auth_check verdict=${authCheck.valid ? "VALID" : "INVALID"} reason=${authCheck.reason}`);

  if (!authCheck.valid) {
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — sessions spawned without valid auth will NOT appear in Cloud Dashboard.`);
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — user must complete /api/auth/login first OR set KILO_API_KEY env`);
  }

  const prompt = process.env.HERMES_INITIAL_PROMPT || "based on readme explain project in 2 lines";
  const logFile = path.join(KILO_DIR, `session-${label}.log`);
  const spawnedAtMs = Date.now();

  log(`_start_kilo_session ${logPrefix(label)} spawning kilo PTY with KILO_REMOTE=1 (auto-enables Cloud Dashboard relay)`);
  const logFd = fs.openSync(logFile, "a");
  const ptyProcess = pty.spawn("kilo", [], {
    name: "xterm-color",
    cols: 120,
    rows: 40,
    cwd: workDir,
    env: {
      ...process.env,
      KILO_REMOTE: "1",
      KILO_DEBUG_SESSION_INGEST: "true",
    },
  });

  const pid = ptyProcess.pid;
  LIVE_PTYS.set(label, ptyProcess);
  log(`_start_kilo_session ${logPrefix(label)} PTY spawned pid=${pid} log=${logFile}`);

  let accumulated = "";
  ptyProcess.onData((data) => {
    accumulated += stripAnsi(data);
    try { fs.writeSync(logFd, data); } catch (_) {}
  });

  const tuiReady = await waitForString(() => accumulated, label, 30, [
    "kilo>", "\u2502 > ", "\u276f ", "> ", "How can I help",
    "Type your message", "Enter prompt", "Send a message", "Ask anything",
    "kilo CLI", "Connected", "connected",
  ]);
  if (!tuiReady) {
    log(`_start_kilo_session ${logPrefix(label)} WARNING — TUI prompt not detected, sending initial prompt anyway`);
  } else {
    log(`_start_kilo_session ${logPrefix(label)} TUI ready, remote auto-enabled via KILO_REMOTE=1 + remote_control=true`);
  }

  // CRITICAL: the "Ask anything" text renders BEFORE the TUI is truly interactive
  // (models are still fetching, WebSocket still connecting, skills still loading).
  // A single write(prompt+"\n") fired at that moment gets DROPPED — no session is
  // ever created, so nothing ingests to the Cloud Dashboard. We instead:
  //   1) wait for the remote-ws to actually connect (from internal logs),
  //   2) type the prompt text, pause, then send Enter as a SEPARATE keystroke,
  //   3) verify a session.created breadcrumb appears; retry a few times if not.
  //
  // Do NOT send /remote — it is a TOGGLE and would DISABLE remote mode.
  // KILO_REMOTE=1 + remote_control:true already auto-enabled remote on startup.

  // Wait until the remote WebSocket is actually connected (or 15s max) so the
  // session we create is registered on a live channel.
  const wsDeadline = Date.now() + 15000;
  while (Date.now() < wsDeadline) {
    const scan = scanInternalLogs(spawnedAtMs);
    if (scan.remoteConnected) {
      log(`_start_kilo_session ${logPrefix(label)} remote-ws connected — TUI is interactive, submitting prompt`);
      break;
    }
    await sleep(1000);
  }
  // Extra settle time for the input box to become focused/interactive.
  await sleep(2000);

  const submitPrompt = () => {
    // Type the text, let the TUI render/register it, THEN send Enter separately.
    ptyProcess.write(prompt);
    return sleep(600).then(() => {
      ptyProcess.write("\r");
      log(`_start_kilo_session ${logPrefix(label)} prompt submitted (text + CR): ${prompt.slice(0, 80)}`);
    });
  };

  await submitPrompt();

  // Verify a session was actually created; retry up to 3 times if the keystrokes
  // were dropped (session.created never appears).
  let submitted = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const verifyDeadline = Date.now() + 8000;
    while (Date.now() < verifyDeadline) {
      const scan = scanInternalLogs(spawnedAtMs);
      if (scan.sessionCreated || scan.cloudSessionId) {
        submitted = true;
        log(`_start_kilo_session ${logPrefix(label)} session.created confirmed on attempt ${attempt}`);
        break;
      }
      await sleep(1000);
    }
    if (submitted) break;
    log(`_start_kilo_session ${logPrefix(label)} no session.created after attempt ${attempt} — re-submitting prompt`);
    await submitPrompt();
  }
  if (!submitted) {
    log(`_start_kilo_session ${logPrefix(label)} WARNING — could not confirm session.created after 3 attempts; prompt keystrokes may be dropped`);
  }

  ptyProcess.onExit(({ exitCode }) => {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    log(`_monitor_exit ${logPrefix(label)} kilo PTY exited code=${exitCode}`);
    // Final sweep of internal logs for the cloud session ID.
    const scan = scanInternalLogs(spawnedAtMs);
    if (scan.cloudSessionId) {
      log(`_monitor_exit ${logPrefix(label)} captured cloud_session_id=${scan.cloudSessionId} (ingestFlushed=${scan.ingestFlushed})`);
    } else {
      log(`_monitor_exit ${logPrefix(label)} no cloud_session_id found in internal logs (files scanned=${scan.files.length})`);
    }
    const sessions = loadSessions();
    for (const s of sessions) {
      if (s.id === label && s.status === "running") {
        s.status = "stopped";
        s.stopped_at = new Date().toISOString();
        s.exit_code = exitCode;
        if (scan.cloudSessionId) s.cloud_session_id = scan.cloudSessionId;
      }
    }
    saveSessions(sessions);
  });

  // The cloud session ID (ses_...) + ingest flush confirmation are written to
  // kilo's INTERNAL log files (/data/kilo/log/*.log), NOT to PTY stdout. Poll
  // those logs (up to 45s) for the kilo-sessions breadcrumbs. This is the ONLY
  // reliable source — the TUI never prints the session ID to its own stdout.
  let cloudSessionId = null;
  const cloudIdDeadline = Date.now() + 45000;
  while (Date.now() < cloudIdDeadline && !cloudSessionId) {
    const scan = scanInternalLogs(spawnedAtMs);
    if (scan.cloudSessionId) {
      cloudSessionId = scan.cloudSessionId;
      log(`_start_kilo_session ${logPrefix(label)} captured cloud_session_id=${cloudSessionId} from internal logs after ${((Date.now() - spawnedAtMs) / 1000).toFixed(1)}s (ingestFlushed=${scan.ingestFlushed} remoteEnabled=${scan.remoteEnabled})`);
      break;
    }
    await sleep(1500);
  }
  if (!cloudSessionId) {
    const scan = scanInternalLogs(spawnedAtMs);
    log(`_start_kilo_session ${logPrefix(label)} no cloud_session_id in internal logs after 45s (files=${scan.files.length} ingestFlushed=${scan.ingestFlushed}) — will retry on exit`);
  }

  return { pid, cloudSessionId, ptyProcess };
}

async function initKiloStartup() {
  try { fs.mkdirSync(KILO_DIR, { recursive: true }); } catch (_) {}

  try {
    const sessions = loadSessions();
    let changed = false;
    const kept = [];
    for (const s of sessions) {
      if (s.status === "killed") {
        const logFile = path.join(KILO_DIR, `session-${s.id}.log`);
        try { fs.unlinkSync(logFile); } catch (_) {}
        if (s.work_dir && fs.existsSync(s.work_dir)) {
          try { fs.rmSync(s.work_dir, { recursive: true, force: true }); } catch (_) {}
        }
        changed = true;
        log(`_startup_recovery removed killed session ${s.id} (log + work_dir cleaned)`);
      } else if (s.status === "running") {
        s.status = "paused";
        s.paused_at = new Date().toISOString();
        changed = true;
        log(`_startup_recovery session ${s.id} paused (process lost on restart)`);
        kept.push(s);
      } else {
        kept.push(s);
      }
    }
    if (changed) saveSessions(kept);
  } catch (e) { log(`_startup_recovery failed: ${e.message}`); }

  try { writeRemoteControlJson(); } catch (e) { log(`_startup writeRemoteControlJson failed (non-fatal): ${e.message}`); }
  try { writeDefaultModel();     } catch (e) { log(`_startup writeDefaultModel failed (non-fatal): ${e.message}`); }
  try { writeAuthJson();         } catch (e) { log(`_startup writeAuthJson failed (non-fatal): ${e.message}`); }
  await checkGateway();

  log("_startup skipping kilo daemon + kilo remote — TUI manages its own server, ingest, and remote WebSocket");
  log("_startup each PTY session with KILO_REMOTE=1 auto-enables its own cloud connection (see kilo-sessions.ts)");
  log("_startup kilo startup complete");
}

// Send a prompt into a live TUI session (the same session the Cloud Dashboard
// controls). Returns true if the session was live and the prompt was written.
function sendPromptToLive(label, prompt) {
  const ptyProcess = LIVE_PTYS.get(label);
  if (!ptyProcess) return false;
  try {
    ptyProcess.write(prompt + "\n");
    log(`_send_prompt ${logPrefix(label)} wrote prompt to live TUI: ${prompt.slice(0, 80)}`);
    return true;
  } catch (e) {
    log(`_send_prompt ${logPrefix(label)} failed: ${e.message}`);
    return false;
  }
}

function isLive(label) {
  return LIVE_PTYS.has(label);
}

module.exports = { startKiloSession, initKiloStartup, writeRemoteControlJson, writeDefaultModel, checkGateway, scanInternalLogs, sendPromptToLive, isLive, LIVE_PTYS };