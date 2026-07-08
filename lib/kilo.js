const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { log, logPrefix, stripAnsi, sleep, waitForString, sanitizeLog } = require("./logger");
const { KILO_DIR, inspectAuth, writeAuthJson } = require("./auth");
const { loadSessions, saveSessions, isAlive, REPOS_DIR } = require("./sessions");

// Registry of live TUI PTYs keyed by session label. Holding the reference keeps
// the interactive TUI (and its connected remote WebSocket to the Cloud
// Dashboard) alive, so prompts sent from the dashboard are executed here in the
// container. Also lets us write prompts directly into the live session.
const LIVE_PTYS = new Map();

// Path to the kilo.jsonc template bundled in the container image. This file uses
// {env:VAR} placeholders for all secrets. On deployment, HF secrets are injected
// as environment variables (see entrypoint.sh) and this function resolves them
// into concrete values before writing a project-level config into each session's
// cloned work directory. Kilo automatically reads ./<workDir>/.kilo/kilo.jsonc
// with higher precedence than the global config, giving each session exactly the
// MCP servers, providers, and indexing config defined here.
const KILO_CONFIG_TEMPLATE = "/app/kilo.jsonc";

// Directory of rule/instruction markdown files bundled into the image. Copied
// into each session's <workDir>/.kilo/rules so the `instructions` glob in the
// project config ("/.kilo/rules/*.md") resolves and the rules are injected into
// every kilo session (ported from the user's opencode rules, supermemory omitted).
const RULES_DIR = "/app/rules";

// Directory of Superpowers skills (obra/superpowers) bundled into the image.
// Copied into each session's <workDir>/.kilo/skills so Kilo auto-discovers them
// (Kilo scans `.kilo/skills/<name>/SKILL.md` in the project config dir). This
// makes the Superpowers methodology available in every session.
const SKILLS_DIR = "/app/superpowers";

function resolveEnvVars(obj) {
  // Deep-walk the config object. Replace any string containing {env:VAR_NAME}
  // with the actual environment variable value. Supports multiple {env:VAR}
  // tokens within a single string. Handles nested objects and arrays.
  const envRe = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
  function walk(val) {
    if (typeof val === "string") {
      return val.replace(envRe, (match, name) => {
        const resolved = process.env[name];
        if (resolved === undefined) {
          log(`_config_env ${name} - NotAvailable`);
          return match;
        }
        log(`_config_env ${name} - Available`);
        return resolved;
      });
    }
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === "object") {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = walk(v);
      return out;
    }
    return val;
  }
  return walk(obj);
}

// Every secret the container expects. Logs only PRESENCE (never values), so
// operators can confirm which integrations are configured from the logs alone.
const EXPECTED_SECRETS = [
  "AGENT_DOCK_API_TOKEN",
  "KILO_API_KEY",
  "GITHUB_TOKEN",
  "CONTEXT7_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "GEMINI_API_KEY",
  "JINA_API_KEY",
];

function logSecretAvailability(prefix) {
  const tag = prefix ? `${prefix} ` : "";
  for (const name of EXPECTED_SECRETS) {
    const present = !!(process.env[name] && process.env[name].length > 0);
    log(`${tag}secret ${name} - ${present ? "Available" : "NotAvailable"}`);
  }
}

async function fetchOpenAICompatibleModels(baseURL, apiKey, label) {
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log(`_config_project ${logPrefix(label)} model fetch failed HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const modelIds = (data.data || []).map((m) => m.id).filter(Boolean);
    log(`_config_project ${logPrefix(label)} fetched ${modelIds.length} models from provider`);
    return modelIds;
  } catch (e) {
    log(`_config_project ${logPrefix(label)} model fetch error: ${e.message}`);
    return null;
  }
}

async function writeProjectConfig(workDir, label) {
  let template;
  try {
    template = JSON.parse(fs.readFileSync(KILO_CONFIG_TEMPLATE, "utf8"));
  } catch (e) {
    log(`_config_project ${logPrefix(label)} cannot read template ${KILO_CONFIG_TEMPLATE}: ${e.message}`);
    return;
  }

  const resolved = resolveEnvVars(template);

  // Dynamically fetch models for openai-compatible providers. This avoids
  // manually listing every model in kilo.jsonc — new models appear automatically
  // when the provider adds them.
  if (resolved.provider && resolved.provider["openai-compatible"]) {
    const p = resolved.provider["openai-compatible"];
    const baseURL = p.options?.baseURL;
    const apiKey = p.options?.apiKey;
    if (baseURL && apiKey && !apiKey.includes("{env:")) {
      const modelIds = await fetchOpenAICompatibleModels(baseURL, apiKey, label);
      if (modelIds && modelIds.length > 0) {
        p.models = {};
        for (const id of modelIds) {
          const name = id.split("/").pop().replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          p.models[id] = {
            name,
            tool_call: true,
            limit: { context: 128000, output: 16384 },
          };
        }
      }
    }
  }
  const kiloDir = path.join(workDir, ".kilo");
  try { fs.mkdirSync(kiloDir, { recursive: true }); } catch (e) {
    log(`_config_project ${logPrefix(label)} cannot create .kilo dir: ${e.message}`);
    return;
  }
  const configPath = path.join(kiloDir, "kilo.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(resolved, null, 2));
  log(`_config_project ${logPrefix(label)} wrote project config to ${configPath}`);

  // Copy the bundled opencode rule/instruction markdown files into this session's
  // .kilo/rules so the `instructions: [".kilo/rules/*.md"]` glob in the project
  // config resolves and the rules are injected into the session. These are read
  // only in the image; a fresh copy per session keeps each work dir self-contained.
  try {
    if (fs.existsSync(RULES_DIR)) {
      const rulesDest = path.join(kiloDir, "rules");
      fs.cpSync(RULES_DIR, rulesDest, { recursive: true });
      const copied = fs.readdirSync(rulesDest);
      log(`_config_project ${logPrefix(label)} copied ${copied.length} rule files to ${rulesDest}`);
    } else {
      log(`_config_project ${logPrefix(label)} RULES_DIR ${RULES_DIR} missing — instructions glob will not resolve`);
    }
  } catch (e) {
    log(`_config_project ${logPrefix(label)} failed to copy rules: ${e.message}`);
  }

  // Copy the bundled Superpowers skills into this session's .kilo/skills so Kilo
  // auto-discovers them (Kilo scans `.kilo/skills/<name>/SKILL.md`). This injects
  // the Superpowers methodology into every session. Read-only in the image; a
  // fresh copy per session keeps each work dir self-contained.
  try {
    if (fs.existsSync(SKILLS_DIR)) {
      const skillsDest = path.join(kiloDir, "skills");
      fs.cpSync(SKILLS_DIR, skillsDest, { recursive: true });
      const copied = fs.readdirSync(skillsDest);
      log(`_config_project ${logPrefix(label)} copied ${copied.length} Superpowers skills to ${skillsDest}`);
    } else {
      log(`_config_project ${logPrefix(label)} SKILLS_DIR ${SKILLS_DIR} missing — Superpowers skills not injected`);
    }
  } catch (e) {
    log(`_config_project ${logPrefix(label)} failed to copy Superpowers skills: ${e.message}`);
  }

  logSecretAvailability(`_config_project ${logPrefix(label)}`);
}

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
  // NOTE: We intentionally do NOT write `model` or `small_model` to the global
  // config. The auto-model (kilo/kilo-auto/free) continuously re-selects free
  // providers and overrides model changes made from the Cloud Dashboard via the
  // remote WebSocket relay. Instead, the initial model for each session is set
  // in the project-level .kilo/kilo.jsonc (written by writeProjectConfig).
  // The Cloud Dashboard can then change the model at any time via remote commands,
  // and those changes will stick because no auto-model is active in any config.
  //
  // Background tasks (session titles, context summarization) use `small_model`.
  // If unset, kilo falls back to google/gemini-3-flash-preview which needs a
  // Google credential we don't have -> 401 UNAUTHENTICATED. The project-level
  // config handles this via the `small_model` field in the template.
  log(`_startup_model global config model/small_model intentionally omitted — Cloud Dashboard controls model`);
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
    // signal that our prompt-injection worked and something will ingest. Keep
    // patterns broad: kilo internal log formats evolve across versions and a
    // missed match means a silent "session never created" false-positive in
    // diagnostics. Match any line that contains a ses_ ID plus a sentinel word
    // indicating a successful session creation, turn open, or ingest start.
    // Also match the minimal patterns from earlier kilo versions.
    if (/type=session\.created publishing|creating session|session\.turn\.open publishing|session\.(?:created|started|initialized)|turn\.(?:open|committed)|sessionId=ses_.*created|ingest.*session.*start|session\.ingest/.test(content)) {
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

// Signatures that mean kilo never reached an interactive prompt. Used to turn a
// silent "keystrokes dropped" failure into an actionable diagnostic. These are
// heuristics — kept broad so any of the common startup failures surfaces.
const KILO_STARTUP_ERROR_RE = /(command not found|cannot (?:find|open)|EACCES|ENOENT|fatal[: ]|panic[: ]|unhandled (?:exception|rejection)|TypeError|ReferenceError|401 Unauthorized|UNAUTHENTICATED|authentication required|auth(?:entication)? failed|invalid (?:api )?key|network error|could not connect|connection refused|exited with code|crash|stack ?trace)/i;

// Matches the Kilo CLI error when a cloud session has been deleted from the
// Cloud Dashboard but the agent dock still holds the stale cloud_session_id.
// Detected during resume so we can tear down the PTY early and start a fresh
// session instead of waiting for the full 30s+ timeout.
const CLOUD_SESSION_IMPORT_FAILED_RE = /failed to import session from cloud/i;

function detectKiloStartupErrors(buffer) {
  const m = buffer.match(KILO_STARTUP_ERROR_RE);
  return m ? m[0] : null;
}

// Dump the tail of the captured PTY buffer into the ring log so the cause of a
// dead/non-interactive TUI is actually visible on the next /api/logs poll
// (instead of a generic "TUI prompt never detected"). The raw bytes already go
// to the session .log file, but that path is not where operators look first.
function dumpPtyTail(tag, label, accumulated) {
  if (!accumulated || accumulated.length === 0) {
    log(`${tag} ${logPrefix(label)} PTY buffer empty — kilo produced no output before exit`);
    return;
  }
  const tail = accumulated.slice(-1500);
  log(`${tag} ${logPrefix(label)} PTY tail (last ${tail.length} chars):\n${sanitizeLog(tail)}`);
}

// liveness guard: check the PTY pid is still alive. If not, log diagnostic tail
// and return a reason so the caller can bail. Returns null if alive.
function checkPtyAlive(pid, label, tag, accumulated) {
  if (pid && isAlive(pid)) return null;
  const pidStr = pid || "unknown";
  log(`${tag} ${logPrefix(label)} PTY pid=${pidStr} DEAD — aborting resume`);
  dumpPtyTail(tag, label, accumulated);
  return `PTY process ${pidStr} died during ${tag}`;
}

// Submit a prompt to the live TUI with ECHO CONFIRMATION. The TUI's input box
// echoes typed text back into the PTY; if our keystrokes never appear, the box
// wasn't focused/ready and they were dropped (the exact failure seen in the
// logs). We only press Enter once the typed text is observed echoed — this
// converts the silent "keystrokes dropped" failure into a detected, retryable
// condition. Returns true only if Enter was actually sent.
async function submitPromptConfirmed(ptyProcess, getBuffer, label, tag, prompt) {
  const beforeLen = getBuffer().length;
  ptyProcess.write(prompt);
  const echoDeadline = Date.now() + 5000;
  let echoed = false;
  while (Date.now() < echoDeadline) {
    const recent = getBuffer().slice(beforeLen);
    if (recent.includes(prompt)) { echoed = true; break; }
    await sleep(150);
  }
  if (!echoed) {
    log(`${tag} ${logPrefix(label)} prompt text NOT echoed by TUI — input box not focused/ready (keystroke drop)`);
    return false;
  }
  await sleep(300);
  ptyProcess.write("\r");
  log(`${tag} ${logPrefix(label)} prompt submitted (echoed + CR): ${prompt.slice(0, 80)}`);
  return true;
}

async function startKiloSession(workDir, label) {
  log(`_start_kilo_session ${logPrefix(label)} work_dir=${workDir}`);

  const authCheck = inspectAuth();
  log(`_start_kilo_session ${logPrefix(label)} auth_check verdict=${authCheck.valid ? "VALID" : "INVALID"} reason=${authCheck.reason}`);

  if (!authCheck.valid) {
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — sessions spawned without valid auth will NOT appear in Cloud Dashboard.`);
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — user must complete /api/auth/login first OR set KILO_API_KEY env`);
  }

  const prompt = process.env.AGENT_DOCK_INITIAL_PROMPT || "based on readme explain project in 2 lines";
  const logFile = path.join(KILO_DIR, `session-${label}.log`);
  const spawnedAtMs = Date.now();

  await writeProjectConfig(workDir, label);

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

  const waitRes = await waitForString(() => accumulated, label, 30, [
    "kilo>", "\u2502 > ", "\u276f ", "> ", "How can I help",
    "Type your message", "Enter prompt", "Send a message", "Ask anything",
    "kilo CLI", "Connected", "connected",
  ], () => isAlive(pid));
  if (!waitRes.matched) {
    if (waitRes.dead) {
      deathReason = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
      log(`_start_kilo_session ${logPrefix(label)} WARNING — TUI prompt not detected, PTY died during wait`);
    } else if (waitRes.timedOut) {
      log(`_start_kilo_session ${logPrefix(label)} WARNING — TUI prompt not detected (timeout)`);
    }
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
    const deadReason = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
    if (deadReason) {
      try { fs.closeSync(logFd); } catch (_) {}
      LIVE_PTYS.delete(label);
      return { pid, cloudSessionId: null, ptyProcess, started: false, reason: deadReason };
    }
  }
  // Extra settle time for the input box to become focused/interactive.
  await sleep(2000);

  const startupErrStart = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
  if (startupErrStart) {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return { pid, cloudSessionId: null, ptyProcess, started: false, reason: startupErrStart };
  }

  // Surface any kilo startup error captured in the PTY output so a non-interactive
  // TUI (the root cause of dropped keystrokes) is diagnosable instead of silent.
  const startupErr = detectKiloStartupErrors(accumulated);
  if (startupErr) {
    log(`_start_kilo_session ${logPrefix(label)} DIAGNOSTIC — kilo startup error signature in PTY: ${startupErr}`);
  }
  if (!waitRes.matched) {
    log(`_start_kilo_session ${logPrefix(label)} DIAGNOSTIC — TUI prompt never detected (waited 30s); proceeding best-effort. Input box may not be focused.`);
  }

  // Verify a session was actually created; retry up to 3 times if the keystrokes
  // were dropped (session.created never appears). Each attempt first CONFIRMS the
  // typed text was echoed by the TUI before pressing Enter — if the keystrokes
  // were dropped we retry rather than silently continuing.
  const MAX_ATTEMPTS = 3;
  let submitted = false;
  let lastReason = "unknown";

  const checkBeforeSubmit = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
  if (checkBeforeSubmit) {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return { pid, cloudSessionId: null, ptyProcess, started: false, reason: checkBeforeSubmit };
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const echoed = await submitPromptConfirmed(ptyProcess, () => accumulated, label, "_start_kilo_session", prompt);
    if (!echoed) {
      lastReason = "prompt keystrokes not echoed by TUI (input box not ready)";
      log(`_start_kilo_session ${logPrefix(label)} attempt ${attempt}: keystrokes dropped — retrying`);
      await sleep(1000);
      continue;
    }
    const verifyDeadline = Date.now() + 8000;
    let confirmed = false;
    while (Date.now() < verifyDeadline) {
      const scan = scanInternalLogs(spawnedAtMs);
      if (scan.sessionCreated || scan.cloudSessionId) {
        confirmed = true;
        log(`_start_kilo_session ${logPrefix(label)} session.created confirmed on attempt ${attempt}`);
        break;
      }
      await sleep(1000);
    }
    if (confirmed) { submitted = true; break; }
    lastReason = "prompt accepted but no session.created breadcrumb in kilo internal logs";
    log(`_start_kilo_session ${logPrefix(label)} attempt ${attempt}: no session.created — re-submitting prompt`);
  }
  if (!submitted) {
    const errScan = scanInternalLogs(spawnedAtMs);
    log(`_start_kilo_session ${logPrefix(label)} WARNING — could not confirm session.created after ${MAX_ATTEMPTS} attempts (${lastReason})`);
    if (!errScan.remoteConnected) {
      log(`_start_kilo_session ${logPrefix(label)} DIAGNOSTIC — remote-ws never connected: Cloud Dashboard relay will fail; check KILO_REMOTE + reachability of api.kilo.ai`);
    }
    if (!authCheck.valid) {
      log(`_start_kilo_session ${logPrefix(label)} DIAGNOSTIC — auth invalid (${authCheck.reason}): kilo may never reach an interactive prompt`);
    }
  }

  ptyProcess.onExit(({ exitCode }) => {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    log(`_monitor_exit ${logPrefix(label)} kilo PTY exited code=${exitCode}`);
    const scan = scanInternalLogs(spawnedAtMs);
    if (scan.cloudSessionId) {
      log(`_monitor_exit ${logPrefix(label)} captured cloud_session_id=${scan.cloudSessionId} (ingestFlushed=${scan.ingestFlushed})`);
    } else {
      log(`_monitor_exit ${logPrefix(label)} no cloud_session_id found in internal logs (files scanned=${scan.files.length})`);
    }
    autoRestartSession(label, exitCode, workDir);
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
    const deadReason = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
    if (deadReason) break;
    await sleep(1500);
  }
  if (!cloudSessionId) {
    const scan = scanInternalLogs(spawnedAtMs);
    log(`_start_kilo_session ${logPrefix(label)} no cloud_session_id in internal logs after 45s (files=${scan.files.length} ingestFlushed=${scan.ingestFlushed}) — will retry on exit`);
  }

  return { pid, cloudSessionId, ptyProcess, started: submitted, reason: submitted ? null : lastReason };
}

async function autoRestartSession(label, exitCode, workDir) {
  const MAX_RESTARTS = 3;
  const RESTART_DELAY_MS = 5000;

  const sessions = loadSessions();
  const s = sessions.find((s) => s.id === label);
  if (!s) return;

  if (s.status !== "running") {
    log(`_auto_restart ${logPrefix(label)} skipping — session was not running (status=${s.status})`);
    return;
  }

  const restartCount = (s.restart_count || 0) + 1;
  if (restartCount > MAX_RESTARTS) {
    log(`_auto_restart ${logPrefix(label)} max restarts (${MAX_RESTARTS}) reached — giving up`);
    s.status = "stopped";
    s.stopped_at = new Date().toISOString();
    s.exit_code = exitCode;
    s.restart_count = restartCount;
    saveSessions(sessions);
    return;
  }

  log(`_auto_restart ${logPrefix(label)} restart ${restartCount}/${MAX_RESTARTS} in ${RESTART_DELAY_MS / 1000}s (exit_code=${exitCode})`);
  s.restart_count = restartCount;
  saveSessions(sessions);

  await sleep(RESTART_DELAY_MS);

  try {
    const result = await startKiloSession(workDir, label);
    if (result.started) {
      log(`_auto_restart ${logPrefix(label)} restart ${restartCount} succeeded (pid=${result.pid}, cloud=${result.cloudSessionId})`);
    } else {
      log(`_auto_restart ${logPrefix(label)} restart ${restartCount} failed: ${result.reason}`);
    }
  } catch (e) {
    log(`_auto_restart ${logPrefix(label)} restart ${restartCount} error: ${e.message}`);
  }
}

async function initKiloStartup() {
  try { fs.mkdirSync(KILO_DIR, { recursive: true }); } catch (_) {}

  logSecretAvailability("_startup_secrets");

  // Validate the kilo.jsonc template at boot. A broken template causes silent
  // MCP/provider failure in every session — catch it early.
  try {
    const raw = fs.readFileSync(KILO_CONFIG_TEMPLATE, "utf8");
    JSON.parse(raw);
    log(`_startup_config template ${KILO_CONFIG_TEMPLATE} valid (${raw.length} bytes)`);
  } catch (e) {
    log(`_startup_config SEVERE — template ${KILO_CONFIG_TEMPLATE} is invalid: ${e.message}`);
    log(`_startup_config SEVERE — MCP and provider injection will silently fail for ALL sessions`);
  }

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

    // Clean orphaned log files and work directories that don't belong to any
    // tracked session. This handles cases where sessions.json was wiped or the
    // mounted volume retained artifacts from a previous container lifecycle.
    const activeIds = new Set(kept.map((s) => s.id));

    try {
      const logFiles = fs.readdirSync(KILO_DIR).filter((f) => f.startsWith("session-") && f.endsWith(".log"));
      for (const f of logFiles) {
        const id = f.replace("session-", "").replace(".log", "");
        if (!activeIds.has(id)) {
          try { fs.unlinkSync(path.join(KILO_DIR, f)); } catch (_) {}
          log(`_startup_cleanup removed orphan log ${f}`);
        }
      }
    } catch (_) {}

    try {
      const reposDir = REPOS_DIR;
      if (fs.existsSync(reposDir)) {
        const dirs = fs.readdirSync(reposDir);
        for (const d of dirs) {
          if (!activeIds.has(d)) {
            try { fs.rmSync(path.join(reposDir, d), { recursive: true, force: true }); } catch (_) {}
            log(`_startup_cleanup removed orphan work_dir ${d}`);
          }
        }
      }
    } catch (_) {}
  } catch (e) { log(`_startup_recovery failed: ${e.message}`); }

  try { writeRemoteControlJson(); } catch (e) { log(`_startup writeRemoteControlJson failed (non-fatal): ${e.message}`); }
  try { writeDefaultModel();     } catch (e) { log(`_startup writeDefaultModel failed (non-fatal): ${e.message}`); }
  try { writeAuthJson();         } catch (e) { log(`_startup writeAuthJson failed (non-fatal): ${e.message}`); }
  await checkGateway();

  log("_startup skipping kilo daemon + kilo remote — TUI manages its own server, ingest, and remote WebSocket");
  log("_startup each PTY session with KILO_REMOTE=1 auto-enables its own cloud connection (see kilo-sessions.ts)");
  log("_startup kilo startup complete");
}

// Resume a paused/stopped session by spawning a new interactive TUI PTY in the
// same work directory. The TUI auto-connects to the Cloud Dashboard via KILO_REMOTE=1
// so the user can continue from where they left off.
//
// oldCloudSessionId: the cloud_session_id from the previous session run. When
// present, we pass --session <id> --cloud-fork to Kilo so it reconnects to the
// existing cloud session (preserving prompt history). After the TUI boots and
// remote-ws connects, we verify the old ID is active in Kilo's internal logs:
//   - If old ID found within 15s → old session is still valid, keep it
//   - If old ID NOT found → old session was deleted/invalidated in Cloud Dashboard.
//     Submit an initial prompt to create a NEW session, capture the new ID.
async function resumeKiloSession(workDir, label, oldCloudSessionId) {
  log(`_resume_kilo_session ${logPrefix(label)} work_dir=${workDir} old_cloud_id=${oldCloudSessionId || "none"}`);

  const prompt = process.env.AGENT_DOCK_INITIAL_PROMPT || "based on readme explain project in 2 lines";
  const logFile = path.join(KILO_DIR, `session-${label}.log`);
  const spawnedAtMs = Date.now();

  await writeProjectConfig(workDir, label);

  // If we have an old cloud session ID, tell Kilo to reconnect to it via
  // --session and --cloud-fork. This preserves the conversation history in the
  // Cloud Dashboard. If the old session was deleted, Kilo will start fresh.
  const kiloArgs = [];
  if (oldCloudSessionId) {
    kiloArgs.push("--session", oldCloudSessionId, "--cloud-fork");
  }

  log(`_resume_kilo_session ${logPrefix(label)} spawning kilo PTY with KILO_REMOTE=1${oldCloudSessionId ? ` args=[${kiloArgs.join(" ")}]` : ""}`);
  const logFd = fs.openSync(logFile, "a");
  const ptyProcess = pty.spawn("kilo", kiloArgs, {
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
  log(`_resume_kilo_session ${logPrefix(label)} PTY spawned pid=${pid} log=${logFile}`);

  let accumulated = "";
  ptyProcess.onData((data) => {
    accumulated += stripAnsi(data);
    try { fs.writeSync(logFd, data); } catch (_) {}
  });

  // First liveness check: kilo can crash during startup before any output
  // reaches the PTY. If pid is already dead here, skip all waits.
  let deathReason = null;

  const nope = checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
  if (nope) {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return { pid, ptyProcess, cloudSessionId: null, started: false, reason: nope };
  }

  const tuiReady = await waitForString(() => accumulated, label, 30, [
    "kilo>", "\u2502 > ", "\u276f ", "> ", "How can I help",
    "Type your message", "Enter prompt", "Send a message", "Ask anything",
    "kilo CLI", "Connected", "connected",
  ], () => isAlive(pid));
  if (!tuiReady.matched) {
    deathReason = checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
    if (tuiReady.dead) {
      log(`_resume_kilo_session ${logPrefix(label)} WARNING — TUI prompt not detected, PTY died during wait`);
    } else {
      log(`_resume_kilo_session ${logPrefix(label)} WARNING — TUI prompt not detected (timeout)`);
    }
  } else {
    log(`_resume_kilo_session ${logPrefix(label)} TUI ready, remote auto-enabled`);
  }

  // Detect deleted cloud session early. When the Cloud Dashboard session is
  // deleted but we passed --session <oldId>, kilo prints this error and then
  // exits. Tear down the PTY immediately so the server can start a fresh
  // session instead of waiting 30s+ for remote-ws / old-ID validation.
  if (oldCloudSessionId && CLOUD_SESSION_IMPORT_FAILED_RE.test(accumulated)) {
    log(`_resume_kilo_session ${logPrefix(label)} cloud session import FAILED — old session ${oldCloudSessionId} was deleted from Cloud Dashboard`);
    dumpPtyTail("_resume_kilo_session", label, accumulated);
    try { ptyProcess.kill(); } catch (_) {}
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return { pid, ptyProcess, cloudSessionId: null, started: false, reason: "cloud_session_deleted", importFailed: true };
  }

  // Wait for remote-ws to connect so the TUI is visible in Cloud Dashboard.
  // Periodically check liveness — a dead kilo won't ever connect.
  const wsDeadline = Date.now() + 15000;
  let remoteConnected = false;
  while (Date.now() < wsDeadline && !deathReason) {
    const scan = scanInternalLogs(spawnedAtMs);
    if (scan.remoteConnected) {
      remoteConnected = true;
      log(`_resume_kilo_session ${logPrefix(label)} remote-ws connected`);
      break;
    }
    await sleep(1000);
    deathReason = deathReason || checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
  }

  // After remote-ws connects (or times out), recheck liveness before spending
  // 15s+ in the old-session-id validity loop. The TUI died during ws wait above
  // -> don't try to submit prompts.
  deathReason = deathReason || checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
  if (deathReason) {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return { pid, ptyProcess, cloudSessionId: null, started: false, reason: deathReason };
  }

  // After remote-ws connects, check if old session ID is still active.
  const startupErr = detectKiloStartupErrors(accumulated);
  if (startupErr) {
    log(`_resume_kilo_session ${logPrefix(label)} DIAGNOSTIC — kilo startup error signature in PTY: ${startupErr}`);
  }
    if (!tuiReady.matched) {
      log(`_resume_kilo_session ${logPrefix(label)} DIAGNOSTIC — TUI prompt never detected (waited 30s); input box may not be focused.`);
      dumpPtyTail("_resume_kilo_session", label, accumulated);
    }
  if (!remoteConnected) {
    log(`_resume_kilo_session ${logPrefix(label)} DIAGNOSTIC — remote-ws never connected within 15s; dashboard relay may fail`);
  }
  let resolvedCloudSessionId = null;
  let needsNewSession = true;
  let submitted = false;
  let lastReason = "unknown";

  if (oldCloudSessionId) {
    const checkDeadline = Date.now() + 15000;
    log(`_resume_kilo_session ${logPrefix(label)} checking if old session ${oldCloudSessionId} is still valid...`);
    while (Date.now() < checkDeadline) {
      const scan = scanInternalLogs(spawnedAtMs);
      if (scan.cloudSessionId) {
        if (scan.cloudSessionId === oldCloudSessionId) {
          resolvedCloudSessionId = oldCloudSessionId;
          needsNewSession = false;
          log(`_resume_kilo_session ${logPrefix(label)} cloud_session_id MATCH — old session still valid, preserving history`);
          break;
        }
        // A different session ID appeared — old was definitely invalidated.
        resolvedCloudSessionId = scan.cloudSessionId;
        needsNewSession = false;
        log(`_resume_kilo_session ${logPrefix(label)} cloud_session_id CHANGED ${oldCloudSessionId} → ${scan.cloudSessionId} (old session invalidated/deleted)`);
        break;
      }
      deathReason = deathReason || checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
      if (deathReason) break;
      await sleep(1500);
    }
    if (deathReason) {
      try { fs.closeSync(logFd); } catch (_) {}
      LIVE_PTYS.delete(label);
      return { pid, ptyProcess, cloudSessionId: null, started: false, reason: deathReason };
    }
  }

  if (needsNewSession) {
    log(`_resume_kilo_session ${logPrefix(label)} old session not reusable — submitting initial prompt to create new session`);
    await sleep(2000);

    deathReason = deathReason || checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
    if (deathReason) {
      try { fs.closeSync(logFd); } catch (_) {}
      LIVE_PTYS.delete(label);
      return { pid, ptyProcess, cloudSessionId: null, started: false, reason: deathReason };
    }

    const submitPrompt = () => submitPromptConfirmed(ptyProcess, () => accumulated, label, "_resume_kilo_session", prompt);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const echoed = await submitPrompt();
      if (!echoed) {
        lastReason = "prompt keystrokes not echoed by TUI (input box not ready)";
        log(`_resume_kilo_session ${logPrefix(label)} attempt ${attempt}: keystrokes dropped — retrying`);
        await sleep(1000);
        continue;
      }
      const verifyDeadline = Date.now() + 8000;
      let confirmed = false;
      while (Date.now() < verifyDeadline) {
        const scan = scanInternalLogs(spawnedAtMs);
        if (scan.sessionCreated || scan.cloudSessionId) {
          confirmed = true;
          log(`_resume_kilo_session ${logPrefix(label)} session.created confirmed on attempt ${attempt}`);
          break;
        }
        await sleep(1000);
      }
      if (confirmed) { submitted = true; break; }
      lastReason = "prompt accepted but no session.created breadcrumb in kilo internal logs";
      log(`_resume_kilo_session ${logPrefix(label)} attempt ${attempt}: no session.created — re-submitting prompt`);
    }
    if (!submitted) {
      const errScan = scanInternalLogs(spawnedAtMs);
      log(`_resume_kilo_session ${logPrefix(label)} WARNING — could not confirm session.created after 3 attempts (${lastReason})`);
      if (!errScan.remoteConnected) {
        log(`_resume_kilo_session ${logPrefix(label)} DIAGNOSTIC — remote-ws never connected: Cloud Dashboard relay may fail`);
      }
    }

    // Capture the new cloud_session_id from internal logs.
    const cloudIdDeadline = Date.now() + 45000;
    while (Date.now() < cloudIdDeadline && !resolvedCloudSessionId) {
      const scan = scanInternalLogs(spawnedAtMs);
      if (scan.cloudSessionId) {
        resolvedCloudSessionId = scan.cloudSessionId;
        log(`_resume_kilo_session ${logPrefix(label)} captured new cloud_session_id=${resolvedCloudSessionId} after ${((Date.now() - spawnedAtMs) / 1000).toFixed(1)}s`);
        break;
      }
      deathReason = deathReason || checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
      if (deathReason) break;
      await sleep(1500);
    }
    if (!resolvedCloudSessionId && !deathReason) {
      log(`_resume_kilo_session ${logPrefix(label)} no cloud_session_id in internal logs — will retry on exit`);
    }
  } else {
    // Old session is valid (id matched). We did NOT submit a prompt in the
    // needsNewSession path because the goal is to preserve history and let the
    // user drive from the Cloud Dashboard. BUT a matched id only proves kilo
    // booted and connected to the cloud — it does NOT prove the TUI became
    // interactive (see the 361ce879 incident: id MATCHED yet the PTY died with
    // no "Ask anything" ever rendered). If the TUI never focused, the dashboard
    // has nothing to control. Attempt to focus the input box once via
    // echo-confirmed keystrokes; if the PTY is already dead this returns false
    // and we report the resume as not-live instead of a phantom success.
    deathReason = deathReason || checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
    if (deathReason) {
      try { fs.closeSync(logFd); } catch (_) {}
      LIVE_PTYS.delete(label);
      return { pid, ptyProcess, cloudSessionId: resolvedCloudSessionId || null, started: false, reason: deathReason };
    }
    if (!tuiReady.matched) {
      log(`_resume_kilo_session ${logPrefix(label)} old session valid but TUI not interactive — attempting to focus input box (input box may not be focused)`);
      log(`_resume_kilo_session ${logPrefix(label)} old session valid but TUI not interactive — attempting to focus input box (input box may not be focused)`);
      let echoed = false;
      try {
        echoed = await submitPromptConfirmed(ptyProcess, () => accumulated, label, "_resume_kilo_session", prompt);
      } catch (e) {
        log(`_resume_kilo_session ${logPrefix(label)} focus attempt error: ${e.message}`);
      }
      if (echoed) {
        submitted = true;
        log(`_resume_kilo_session ${logPrefix(label)} input box focused via prompt echo — session is live`);
      } else {
        lastReason = "old session valid but TUI input box never focused / PTY dead (keystrokes not echoed)";
        log(`_resume_kilo_session ${logPrefix(label)} WARNING — ${lastReason}`);
        dumpPtyTail("_resume_kilo_session", label, accumulated);
      }
    }
  }

  ptyProcess.onExit(({ exitCode }) => {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    log(`_monitor_exit ${logPrefix(label)} kilo PTY exited code=${exitCode}`);
    if (exitCode !== 0) {
      dumpPtyTail("_monitor_exit", label, accumulated);
    }
    const scan = scanInternalLogs(spawnedAtMs);
    const sessions = loadSessions();
    for (const s of sessions) {
      if (s.id === label && s.status === "running") {
        if (scan.cloudSessionId) s.cloud_session_id = scan.cloudSessionId;
      }
    }
    saveSessions(sessions);
    autoRestartSession(label, exitCode, workDir);
  });

  // A matched cloud_session_id alone does NOT prove the TUI is live: kilo can
  // reconnect to the old session (emitting the id into its internal log) and
  // then crash/exits before the input box is ever interactive. Treat the resume
  // as actually started only if the TUI became interactive (prompt detected)
  // OR the live remote-ws control channel connected. Otherwise the session is
  // reported running while the PTY is already dead.
  const live = submitted || (resolvedCloudSessionId && (tuiReady || remoteConnected));
  if (deathReason) {
    try { fs.closeSync(logFd); } catch (_) {}
  }
  const reason = deathReason || (live ? null
    : resolvedCloudSessionId
      ? "cloud session id matched but TUI never became interactive (prompt not detected, remote-ws not connected)"
      : (lastReason || "no cloud session id captured"));
  if (!live) {
    dumpPtyTail("_resume_kilo_session", label, accumulated);
  }
  return { pid, ptyProcess, cloudSessionId: resolvedCloudSessionId, started: live, reason };
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

module.exports = { startKiloSession, resumeKiloSession, initKiloStartup, writeRemoteControlJson, writeDefaultModel, checkGateway, scanInternalLogs, sendPromptToLive, isLive, LIVE_PTYS, writeProjectConfig, resolveEnvVars, detectKiloStartupErrors, submitPromptConfirmed, checkPtyAlive };