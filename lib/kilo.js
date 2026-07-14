const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { log, logPrefix, stripAnsi, sleep, waitForString, sanitizeLog } = require("./logger");
const { KILO_DIR, inspectAuth, writeAuthJson } = require("./auth");
const reposLib = require("./repos");
const { REPOS_DIR, REPOS_FILE } = reposLib;

// Registry of live TUI PTYs keyed by session label. Holding the reference keeps
// the interactive TUI (and its connected remote WebSocket to the Cloud
// Dashboard) alive, so prompts sent from the dashboard are executed here in the
// container. Also lets us write prompts directly into the live session.
const LIVE_PTYS = new Map();

// Path to the kilo.jsonc template bundled in the container image. All secrets
// are referenced as {env:VAR} placeholders. On deployment, HF secrets are
// injected as environment variables (see entrypoint.sh) and inherited by the
// kilo child process spawned here; Kilo resolves {env:VAR} against its runtime
// env, so this function writes the template's placeholders AS-IS into each
// session's ./<workDir>/.kilo/kilo.jsonc. Nothing plaintext ever lands in the
// session's project config — keys live only in HF_SECRETS / process.env.
// Kilo reads ./<workDir>/.kilo/kilo.jsonc with higher precedence than the
// global config, giving each session exactly the MCP servers, providers, and
// indexing config defined here.
const KILO_CONFIG_TEMPLATE = "/app/kilo.jsonc";

// Directory of rule/instruction markdown files bundled into the image. Copied
// into each session's <workDir>/.kilo/rules so the `instructions` glob in the
// project config ("/.kilo/rules/*.md") resolves and the rules are injected into
// every kilo session (ported from the user's opencode rules, supermemory omitted).
const RULES_DIR = "/app/rules";

// Directory of always-available skills, downloaded from obra/superpowers at
// Docker build time (see Dockerfile). Copied into each session's
// <workDir>/.kilo/skills so Kilo auto-discovers them (Kilo scans
// `.kilo/skills/<name>/SKILL.md` in the project config dir). This makes the
// Superpowers methodology available in every session.
const SKILLS_DIR = "/app/superpowers";

// Every secret the container expects. Logs only PRESENCE (never values), so
// operators can confirm which integrations are configured from the logs alone.
const EXPECTED_SECRETS = [
  "AGENT_DOCK_API_TOKEN",
  "KILO_API_KEY",
  "GITHUB_TOKEN",
  "CONTEXT7_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "IAMHC_API_KEY",
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

async function writeProjectConfig(workDir, label, opts = {}) {
  let template;
  try {
    template = JSON.parse(fs.readFileSync(KILO_CONFIG_TEMPLATE, "utf8"));
  } catch (e) {
    log(`_config_project ${logPrefix(label)} cannot read template ${KILO_CONFIG_TEMPLATE}: ${e.message}`);
    return;
  }

  // Without KILO_API_KEY, Kilo cannot validate custom providers against the
  // cloud API. The startup bootstrap fires 6 requests: 4 of them (config.providers,
  // provider.list, app.agents, config.get) require cloud auth and will fail with
  // "Unexpected server error", killing the PTY. Skip the provider block entirely
  // when no cloud key is available — the auto-model (kilo/kilo-auto/free) still
  // works, and the Cloud Dashboard can still control the model via remote commands.
  //
  // The same cloud validation failure also happens WITH a valid KILO_API_KEY when
  // custom openai-compatible providers (IAMHC, OpenRouter) with a `baseURL` are
  // declared — kilo 7.4.x's cloud API rejects them with "Unexpected server error"
  // (the CLI-side fix PR Kilo-Org/kilocode#11835 lands in 7.5.0). When
  // opts.skipProvider is set (retry path after a detected cloud-validation death),
  // drop the provider block so the PTY stays alive. The user loses local custom
  // providers on this retry, but the session is functional via Kilo Gateway models
  // controlled from the Cloud Dashboard.
  if (!process.env.KILO_API_KEY || opts.skipProvider) {
    const reason = opts.skipProvider
      ? "retry after cloud-validation failure — skipping provider block (7.4.x cloud API rejects custom baseURL providers)"
      : "KILO_API_KEY not set — skipping provider block (cloud validation will fail without it)";
    log(`_config_project ${logPrefix(label)} ${reason}`);
    delete template.provider;
  }

  // Custom openai-compatible providers (e.g. IAMHC, OpenRouter) declared with a
  // `baseURL` in `provider.<id>.options` ARE surfaced in the Kilo Cloud Dashboard
  // for /remote sessions via the `list_models` protocol. The CLI-side support
  // (PR Kilo-Org/kilocode#11835) merged 2026-07-06 and the Cloud Dashboard side
  // (PR Kilo-Org/cloud#4325) merged 2026-07-07 — both AFTER kilo 7.4.1 shipped
  // (2026-07-03). The changeset marks #11835 as `@kilocode/cli: minor`, so the
  // feature lands in **kilo 7.5.0** (next minor release), NOT in any 7.4.x patch.
  // Until 7.5.0 ships, the Cloud Dashboard dropdown shows only Kilo Gateway
  // models — IAMHC and opencode-native models are invisible remotely even though
  // `kilo models IAMHC` lists them locally. The dashboard dropdown also requires
  // an explicit `models` sub-block under `provider.<id>` in kilo.jsonc (see
  // KILO_CONFIG_TEMPLATE); provider.<id> is dropped from the catalog entirely
  // when `models` is empty/absent. The session's inference always runs locally in
  // this container against the custom baseURL — the dashboard is only a remote
  // view/control surface.
  const kiloDir = path.join(workDir, ".kilo");
  try { fs.mkdirSync(kiloDir, { recursive: true }); } catch (e) {
    log(`_config_project ${logPrefix(label)} cannot create .kilo dir: ${e.message}`);
    return;
  }

  // Stale-state guard: kilo's config loader reads BOTH `.kilo/kilo.jsonc` and
  // `.kilo/kilo.json` in the project dir. If a previous deploy (or kilo's own
  // boot sequence on 7.4.x) ever left `kilo.json` as a directory or stale file,
  // the loader crashes with EISDIR / Unexpected server error at startup and the
  // PTY dies in "TUI ready" —> "4 of 6 requests failed". HF persistent storage
  // means crud from older deploys survives restarts, so we always clean aside
  // from the .jsonc we are about to write. Also clean `kilo.json5`/`kilo.jsonl`
  // if present (less common but harmless to remove since we own this directory).
  for (const stale of ["kilo.json", "kilo.json5", "kilo.jsonl", "opencode.json", "opencode.jsonc"]) {
    const stalePath = path.join(kiloDir, stale);
    try {
      const st = fs.statSync(stalePath);
      if (st.isDirectory()) {
        fs.rmSync(stalePath, { recursive: true, force: true });
        log(`_config_project ${logPrefix(label)} removed stale ${stale}/ directory`);
      } else {
        fs.unlinkSync(stalePath);
        log(`_config_project ${logPrefix(label)} removed stale ${stale} file`);
      }
    } catch (_) { /* not present — expected */ }
  }

  const configPath = path.join(kiloDir, "kilo.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
  log(`_config_project ${logPrefix(label)} wrote project config (placeholders only) to ${configPath}`);

  // Also write a MINIMAL config to <workDir>/kilo.json (at the workdir root,
  // NOT inside .kilo/). The Kilo Cloud Dashboard's FileSystem.readFile RPC just
  // needs the file to EXIST — it gets model/provider info from the remote
  // WebSocket, not from this file. When absent, the dashboard logs
  // "BadResource: FileSystem.readFile (<workDir>/kilo.json) Failed" and prompt
  // submission breaks.
  //
  // CRITICAL: we write ONLY {"snapshot": false} here — NOT the full resolved
  // config. Kilo reads <workDir>/kilo.json as a PROJECT-level config, which has
  // HIGHER priority than the global config. If we wrote the full config
  // (including the `provider` block and `small_model`), kilo's config merge
  // could interfere with model changes from the Cloud Dashboard after the
  // session is active (kilo-org/kilocode#8978 — "custom model configured for
  // agent/mode prevents changing models"). By writing only {"snapshot": false},
  // the project-level config only overrides `snapshot` and leaves `model`,
  // `provider`, `small_model` etc. to the global config + dashboard remote
  // control. The full CLI config stays in .kilo/kilo.jsonc (which kilo reads
  // from the .kilo/ subdirectory and has the provider block the CLI needs).
  const rootConfigPath = path.join(workDir, "kilo.json");
  try {
    fs.writeFileSync(rootConfigPath, JSON.stringify({ snapshot: false }, null, 2));
    log(`_config_project ${logPrefix(label)} wrote minimal dashboard config to ${rootConfigPath}`);
  } catch (e) {
    log(`_config_project ${logPrefix(label)} SEVERE — cannot write ${rootConfigPath}: ${e.message} (Cloud Dashboard prompt submission will fail)`);
  }

  // Also write minimal `snapshot: false` config snippets to the project-level
  // opencode.json / opencode.jsonc paths. Kilo reads these at the project level
  // too (it reads any of kilo.json, kilo.jsonc, opencode.json, opencode.jsonc
  // in the project root and .kilo/). A minimal { "snapshot": false } is enough
  // — kilo merges all project configs, and the full template is already in
  // .kilo/kilo.jsonc and ./kilo.json. These guard against the "Initializing
  // snapshot" being triggered from a config path we weren't covering.
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = path.join(workDir, name);
    try {
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) {}
      existing.snapshot = false;
      fs.writeFileSync(p, JSON.stringify(existing, null, 2));
      log(`_config_project ${logPrefix(label)} wrote snapshot=false to ${p}`);
    } catch (e) {
      log(`_config_project ${logPrefix(label)} could not write ${p}: ${e.message}`);
    }
  }

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

  // Merge additional bundled skills/plugins (Karpathy guidelines, Caveman,
  // Context-mode) from /app/extra-skills/<name>/skills into this session's
  // .kilo/skills so Kilo auto-discovers them alongside Superpowers. Read-only in
  // the image; a fresh copy per session keeps each work dir self-contained.
  try {
    const EXTRA_SKILLS_ROOT = "/app/extra-skills";
    if (fs.existsSync(EXTRA_SKILLS_ROOT)) {
      for (const name of fs.readdirSync(EXTRA_SKILLS_ROOT)) {
        const src = path.join(EXTRA_SKILLS_ROOT, name, "skills");
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, skillsDest, { recursive: true });
      }
      const extra = fs.readdirSync(skillsDest);
      log(`_config_project ${logPrefix(label)} merged extra skills from /app/extra-skills into ${skillsDest} (now ${extra.length} skills)`);
    } else {
      log(`_config_project ${logPrefix(label)} EXTRA_SKILLS_ROOT ${EXTRA_SKILLS_ROOT} missing — bundled skills/plugins not injected`);
    }
  } catch (e) {
    log(`_config_project ${logPrefix(label)} failed to copy extra skills: ${e.message}`);
  }

  logSecretAvailability(`_config_project ${logPrefix(label)}`);
}

function writeRemoteControlJson() {
  // Kilo reads and MERGES all of these global config files at startup
  // (confirmed from kilo internal logs:
  //   config.json, kilo.json, kilo.jsonc, opencode.json, opencode.jsonc).
  // The `snapshot` setting must be `false` in ALL of them — if any file is
  // missing the setting, kilo's merge can fall back to the default (`true`),
  // which triggers the "Initializing snapshot…" state on the Cloud Dashboard.
  // This is also why we call this function before EVERY session spawn (not
  // just at boot): kilo can overwrite the global config at runtime, dropping
  // our `snapshot: false` between sessions.
  const cfgPaths = [
    path.join(KILO_DIR, "kilo.json"),
    path.join(KILO_DIR, "kilo.jsonc"),
    path.join(KILO_DIR, "config.json"),
    path.join(KILO_DIR, "opencode.json"),
    path.join(KILO_DIR, "opencode.jsonc"),
  ];

  for (const cfgPath of cfgPaths) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) {}
    cfg.remote_control = true;
    // Kilo's snapshot feature reads `snapshot` from the GLOBAL config, not the
    // per-session project config. Disabling it here too stops the
    // "Initializing snapshot…" state that otherwise shows on the Cloud Dashboard
    // (and hangs on large repos with many uncommitted files — Kilo issue #11282).
    cfg.snapshot = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }
  log(`_startup_config remote_control=true, snapshot=false written to ${cfgPaths.length} global config files in ${KILO_DIR}`);
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

// Kilo's internal logger writes one file per process invocation at
// /data/kilo/log/<ISO-datetime>.log (e.g. 2026-07-09T08-12-38.log). Over a
// single day this accumulates many small files — one per session start/resume.
// This consolidator merges all datetime-named files for the same day into a
// single <YYYY-MM-DD>.log, so there is ONE log file per day. It is idempotent:
// already-consolidated date-only files are left untouched, and files still
// being written (modified within STALE_MS) are skipped to avoid racing with a
// live kilo process that has the file open.
function consolidateKiloLogs() {
  const logDir = path.join(KILO_DIR, "log");
  let files = [];
  try { files = fs.readdirSync(logDir); } catch (_) { return; }

  const dateOnlyRe = /^\d{4}-\d{2}-\d{2}\.log$/;
  const datePrefixRe = /^(\d{4}-\d{2}-\d{2})/;
  const STALE_MS = 60 * 1000;
  const now = Date.now();

  const groups = {};
  for (const f of files) {
    if (!f.endsWith(".log")) continue;
    if (dateOnlyRe.test(f)) continue;
    const m = f.match(datePrefixRe);
    if (!m) continue;
    const date = m[1];
    const full = path.join(logDir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (now - st.mtimeMs < STALE_MS) continue;
    if (!groups[date]) groups[date] = [];
    groups[date].push({ full, mtime: st.mtimeMs });
  }

  let mergedCount = 0;
  for (const [date, entries] of Object.entries(groups)) {
    entries.sort((a, b) => a.mtime - b.mtime);
    const target = path.join(logDir, `${date}.log`);
    const fd = fs.openSync(target, "a");
    for (const { full } of entries) {
      try {
        const content = fs.readFileSync(full, "utf8");
        if (content.length > 0) fs.writeSync(fd, content);
      } catch (_) {}
      try { fs.unlinkSync(full); } catch (_) {}
      mergedCount++;
    }
    fs.closeSync(fd);
  }
  if (mergedCount > 0) {
    log(`_log_consolidate merged ${mergedCount} datetime log files into date-based files in ${logDir}`);
  }
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

// Matches the kilo CLI startup bootstrap failure when the cloud API rejects
// the configured custom providers (e.g. IAMHC, OpenRouter with a baseURL) on
// kilo 7.4.x. The CLI prints "4 of 6 requests failed: Unexpected server error"
// and lists the affected startup requests (config.providers, provider.list,
// app.agents, config.get), then exits. When detected, we retry the PTY once
// WITHOUT the provider block (see writeProjectConfig skipProvider) so the
// session stays alive via Kilo Gateway models controlled from the dashboard.
const CLOUD_VALIDATION_FAILED_RE = /(\d+ of \d+ requests failed|Unexpected server error|Affected startup requests)/i;

function detectCloudValidationFailure(buffer) {
  return CLOUD_VALIDATION_FAILED_RE.test(buffer);
}

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
  if (pid && reposLib.isAlive(pid)) return null;
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
  return _startKiloSessionInner(workDir, label, { skipProvider: false, isRetry: false });
}

async function _startKiloSessionInner(workDir, label, opts = {}) {
  const { skipProvider = false, isRetry = false } = opts;
  log(`_start_kilo_session ${logPrefix(label)} work_dir=${workDir}${isRetry ? " (RETRY without provider block)" : ""}`);

  const authCheck = inspectAuth();
  log(`_start_kilo_session ${logPrefix(label)} auth_check verdict=${authCheck.valid ? "VALID" : "INVALID"} reason=${authCheck.reason}`);

  if (!authCheck.valid) {
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — sessions spawned without valid auth will NOT appear in Cloud Dashboard.`);
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — provider block skipped (no KILO_API_KEY), auto-model (kilo/kilo-auto/free) will be used.`);
    log(`_start_kilo_session ${logPrefix(label)} SEVERE — user must complete /api/auth/login first OR set KILO_API_KEY env`);
  }

  const prompt = process.env.AGENT_DOCK_INITIAL_PROMPT || "based on readme explain project in 2 lines";
  const logFile = path.join(KILO_DIR, `session-${label}.log`);
  const spawnedAtMs = Date.now();

  // Re-apply snapshot:false to all global config files before each session
  // spawn. Kilo can overwrite the global config at runtime (e.g. when the
  // Cloud Dashboard changes a setting), which may drop our snapshot:false and
  // trigger "Initializing snapshot…" on the next session. This is idempotent.
  try { writeRemoteControlJson(); } catch (e) { log(`_start_kilo_session ${logPrefix(label)} writeRemoteControlJson failed (non-fatal): ${e.message}`); }

  await writeProjectConfig(workDir, label, { skipProvider });
  // Clean any stray directory/FIFO/socket hook entries left over from a
  // pre-fix Agent Dock checkout (or a non-Agent-Dock setup) so git commit/push
  // inside this session doesn't abort with "cannot exec: Permission denied".
  reposLib.sanitizeHooks(workDir);

  logKiloVersion(`_start_kilo_session ${logPrefix(label)}`);
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
      // KILO_CONFIG_CONTENT is an inline JSON config merged LAST by kilo's
      // config loader (packages/opencode/src/config/config.ts), giving it the
      // HIGHEST priority — it overrides ALL config files (global + project).
      // Setting snapshot:false here permanently disables the snapshot feature
      // regardless of what kilo writes to kilo.json/config.json at runtime
      // (e.g. when the Cloud Dashboard changes a setting). This is the
      // bulletproof fix for the recurring "Initializing snapshot…" state that
      // blocks the Cloud Dashboard. The {snapshot:false} in the global config
      // files (writeRemoteControlJson) and project configs (writeProjectConfig)
      // are belt-and-suspenders; this env var is the guarantee.
      KILO_CONFIG_CONTENT: JSON.stringify({ snapshot: false }),
    },
  });

  const pid = ptyProcess.pid;
  const startedAt = Date.now();
  LIVE_PTYS.set(label, { pty: ptyProcess, label, startedAt, lastOutputAt: startedAt, remoteConnectedAt: null });
  log(`_start_kilo_session ${logPrefix(label)} PTY spawned pid=${pid} log=${logFile}`);

  let accumulated = "";
  ptyProcess.onData((data) => {
    accumulated += stripAnsi(data);
    try { fs.writeSync(logFd, data); } catch (_) {}
    const entry = LIVE_PTYS.get(label);
    if (entry) entry.lastOutputAt = Date.now();
  });

  const waitRes = await waitForString(() => accumulated, label, 30, [
    "kilo>", "\u2502 > ", "\u276f ", "> ", "How can I help",
    "Type your message", "Enter prompt", "Send a message", "Ask anything",
    "kilo CLI", "Connected", "connected",
  ], () => reposLib.isAlive(pid));
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

  // Cloud validation failure detection: kilo 7.4.x's cloud API rejects custom
  // baseURL providers with "4 of 6 requests failed: Unexpected server error",
  // killing the PTY. If detected and we haven't already retried, kill the PTY
  // and retry once WITHOUT the provider block so the session stays alive via
  // Kilo Gateway models.
  if (!isRetry && detectCloudValidationFailure(accumulated)) {
    log(`_start_kilo_session ${logPrefix(label)} cloud validation failure detected — retrying without provider block`);
    try { ptyProcess.kill(); } catch (_) {}
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return _startKiloSessionInner(workDir, label, { skipProvider: true, isRetry: true });
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
      const entry = LIVE_PTYS.get(label);
      if (entry && !entry.remoteConnectedAt) entry.remoteConnectedAt = Date.now();
      break;
    }
    await sleep(1000);
    const deadReason = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
    if (deadReason) {
      try { fs.closeSync(logFd); } catch (_) {}
      LIVE_PTYS.delete(label);
      if (!isRetry && detectCloudValidationFailure(accumulated)) {
        log(`_start_kilo_session ${logPrefix(label)} cloud validation failure detected during ws wait — retrying without provider block`);
        return _startKiloSessionInner(workDir, label, { skipProvider: true, isRetry: true });
      }
      return { pid, cloudSessionId: null, ptyProcess, started: false, reason: deadReason };
    }
  }
  // Extra settle time for the input box to become focused/interactive.
  await sleep(2000);

  const startupErrStart = checkPtyAlive(pid, label, "_start_kilo_session", accumulated);
  if (startupErrStart) {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    if (!isRetry && detectCloudValidationFailure(accumulated)) {
      log(`_start_kilo_session ${logPrefix(label)} cloud validation failure detected at startup check — retrying without provider block`);
      return _startKiloSessionInner(workDir, label, { skipProvider: true, isRetry: true });
    }
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
    // updateStatus() will transition the bucket registry entry running→stopped
    // on the next /api/repos poll. No background auto-restart in this model —
    // the user drives recovery via the Start button (per spec).
    // Consolidate datetime-named internal log files into one per day. The
    // STALE_MS guard inside ensures we never touch a file another live session
    // is still writing to.
    try { consolidateKiloLogs(); } catch (_) {}
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

async function autoRestartSession() {
  // Disabled in the bucket model (Q2 of the spec revamp). A dead PTY just
  // transitions the bucket registry entry from running→stopped via
  // updateStatus(), and the user drives recovery explicitly via the Start
  // button on the Repo List screen. This stub exists because the onExit
  // handlers above used to call it; they no longer do, but leaving an empty
  // function (instead of deleting it) keeps any external require()s working
  // without surprises and makes the intent explicit.
  return;
}

// One-time migration from the legacy per-session-id model to the per-repo
// bucket model (spec §7). Idempotent — safe to run on every boot. Steps:
//   1. If /data/sessions.json exists, move it to /data/sessions.json.bak-<ISO>.
//      Never read again, preserved for forensics. If a .bak already exists,
//      pick the next free suffix to avoid overwriting.
//   2. If /data/repos.json does NOT exist, create an empty []. (Do NOT clobber
//      an existing repos.json — a re-boot should not wipe a working registry.)
//   3. Remove legacy work dirs under /data/repos/ that match the old
//      `<repo>__<sessionId>` pattern (anything containing `__`). Orphan
//      cleanup later in initKiloStartup already handles non-registry dirs with
//      the new `<repo>` (no `__`) pattern, so this step is purely for the old
//      model's leftovers.
//   4. Leave /data/kilo/*.log files alone — operators may inspect them.
function migrateLegacySessions() {
  const sessionsFile = "/data/sessions.json";
  if (fs.existsSync(sessionsFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${sessionsFile}.bak-${stamp}`;
    try {
      fs.renameSync(sessionsFile, backup);
      log(`_startup_migration moved legacy ${sessionsFile} to ${backup}`);
    } catch (e) {
      log(`_startup_migration could not move legacy ${sessionsFile}: ${e.message}`);
    }
  }

  if (!fs.existsSync(REPOS_FILE)) {
    try {
      fs.writeFileSync(REPOS_FILE, "[]");
      log(`_startup_migration created empty ${REPOS_FILE}`);
    } catch (e) {
      log(`_startup_migration could not create ${REPOS_FILE}: ${e.message}`);
    }
  }

  let wipedLegacyDirs = 0;
  try {
    if (fs.existsSync(REPOS_DIR)) {
      for (const d of fs.readdirSync(REPOS_DIR)) {
        if (d.includes("__")) {
          try {
            fs.rmSync(path.join(REPOS_DIR, d), { recursive: true, force: true });
            wipedLegacyDirs++;
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  if (wipedLegacyDirs > 0) {
    log(`_startup_migration wiped ${wipedLegacyDirs} legacy <repo>__<sessionId> work dirs`);
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

  // ── Migration + startup recovery ────────────────────────────────────
  // One-time migration from the legacy per-session-id model to the per-repo
  // bucket model. Per spec §7 (wipe-and-start-clean): the legacy
  // /data/sessions.json is moved to a .bak-<ISO> backup (preserved for
  // forensics; never read again), all legacy `<repo>__<sessionId>` work dirs
  // are removed, and a fresh empty /data/repos.json is created.
  try {
    migrateLegacySessions();
  } catch (e) {
    log(`_startup_migration failed: ${e.message}`);
  }

  // Consolidate kilo's datetime-named internal log files (<ISO>.log) into
  // one <YYYY-MM-DD>.log per day. Runs at boot (no sessions active yet at this
  // point) so it's safe — actively-written files are still skipped by the
  // STALE_MS guard in consolidateKiloLogs().
  try {
    consolidateKiloLogs();
  } catch (e) {
    log(`_startup_log_consolidate failed (non-fatal): ${e.message}`);
  }

  try {
    const repos = reposLib.loadRepos();
    let changed = false;
    const kept = [];
    for (const r of repos) {
      // Q3: NO killed-cleanup branch — Kill preserves work_dir + registry
      // entry in the bucket model, so a killed bucket survives a container
      // restart untouched.
      if (r.session_state === "running") {
        // Process is genuinely lost on container restart — mark paused so
        // the user can Resume from the Cloud Dashboard (if cloud id still
        // alive) or Start fresh (if not).
        r.session_state = "paused";
        r.paused_at = new Date().toISOString();
        r.pid = null;
        r.is_active_in_agent_dock = false;
        changed = true;
        log(`_startup_recovery bucket ${r.work_dir_identifier} paused (process lost on restart)`);
        kept.push(r);
      } else {
        kept.push(r);
      }
    }
    if (changed) reposLib.saveRepos(kept);

    // Clean orphaned kilo-session log files and work directories that do not
    // belong to any tracked bucket. Matches against the bucket
    // work_dir_identifier so cleanup never removes a live bucket's clone.
    const activeIds = new Set(kept.map((r) => r.work_dir_identifier));
    const activeWorkDirs = new Set(
      kept.filter((r) => r.work_dir).map((r) => path.basename(r.work_dir))
    );

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
          if (!activeWorkDirs.has(d)) {
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

  // ── Runtime installs (one-time, background) ───────────────────────
  // Downloads Python 3.12/3.14, OpenJDK 21, Node 22+ into the
  // persistent /data/installs/ volume on first boot. Idempotent: if every
  // sentinel binary already exists, the script skips instantly and we don't
  // spawn anything. Spawned detached + unref'd so it never blocks the
  // server; its stdout/stderr stream into the ring buffer via the prefix.
  (function installRuntimes() {
    const sentinels = [
      "/data/installs/node/22/bin/node",
      "/data/installs/python/3.12/bin/python3.12",
      "/data/installs/python/3.14/bin/python3.14",
      "/data/installs/java/21/bin/java",
    ];
    const anyMissing = sentinels.some((f) => {
      try { return !fs.existsSync(f); } catch (_) { return true; }
    });
    if (!anyMissing) {
      log("_startup_runtimes all runtimes already installed, skipping");
      return;
    }
    log("_startup_runtimes some runtimes missing — spawning install script in background");
    const child = cp.spawn("bash", ["/app/scripts/install-runtimes.sh"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const pump = (stream, tag) => {
      if (!stream) return;
      stream.on("data", (d) => {
        for (const line of d.toString().trim().split("\n")) {
          if (line) log(`_install_runtimes ${tag}: ${line}`);
        }
      });
    };
    pump(child.stdout, "stdout");
    pump(child.stderr, "stderr");
    child.on("exit", (code) => log(`_install_runtimes exited code=${code}`));
    child.unref();
  })();

  log("_startup skipping kilo daemon + kilo remote — TUI manages its own server, ingest, and remote WebSocket");
  logKiloVersion("_startup");
  log("_startup each PTY session with KILO_REMOTE=1 auto-enables its own cloud connection (see kilo-sessions.ts)");
  log("_startup kilo startup complete");

  
}

function logKiloVersion(context) {
  try {
    const result = cp.execFileSync("kilo", ["--version"], { encoding: "utf8", timeout: 5000 });
    log(`${context} kilo --version: ${(result || "").trim()}`);
  } catch (e) {
    log(`${context} kilo --version unavailable: ${e.message}`);
  }
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
  return _resumeKiloSessionInner(workDir, label, oldCloudSessionId, { skipProvider: false, isRetry: false });
}

async function _resumeKiloSessionInner(workDir, label, oldCloudSessionId, opts = {}) {
  const { skipProvider = false, isRetry = false } = opts;
  log(`_resume_kilo_session ${logPrefix(label)} work_dir=${workDir} old_cloud_id=${oldCloudSessionId || "none"}${isRetry ? " (RETRY without provider block)" : ""}`);
  logKiloVersion(`_resume_kilo_session ${logPrefix(label)}`);

  const prompt = process.env.AGENT_DOCK_INITIAL_PROMPT || "based on readme explain project in 2 lines";
  const logFile = path.join(KILO_DIR, `session-${label}.log`);
  const spawnedAtMs = Date.now();

  // Re-apply snapshot:false to all global config files before each session
  // spawn (same rationale as startKiloSession — kilo may have overwritten the
  // global config at runtime, dropping our snapshot:false).
  try { writeRemoteControlJson(); } catch (e) { log(`_resume_kilo_session ${logPrefix(label)} writeRemoteControlJson failed (non-fatal): ${e.message}`); }

  await writeProjectConfig(workDir, label, { skipProvider });
  // Clean any stray directory/FIFO/socket hook entries left over from a
  // pre-fix Agent Dock checkout (or a non-Agent-Dock setup) so git commit/push
  // inside this session doesn't abort with "cannot exec: Permission denied".
  reposLib.sanitizeHooks(workDir);

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
      // Same permanent snapshot disable as startKiloSession — see comment there.
      KILO_CONFIG_CONTENT: JSON.stringify({ snapshot: false }),
    },
  });

  const pid = ptyProcess.pid;
  const startedAt = Date.now();
  LIVE_PTYS.set(label, { pty: ptyProcess, label, startedAt, lastOutputAt: startedAt, remoteConnectedAt: null });
  log(`_resume_kilo_session ${logPrefix(label)} PTY spawned pid=${pid} log=${logFile}`);

  let accumulated = "";
  ptyProcess.onData((data) => {
    accumulated += stripAnsi(data);
    try { fs.writeSync(logFd, data); } catch (_) {}
    const entry = LIVE_PTYS.get(label);
    if (entry) entry.lastOutputAt = Date.now();
  });

  // First liveness check: kilo can crash during startup before any output
  // reaches the PTY. If pid is already dead here, skip all waits.
  let deathReason = null;

  const nope = checkPtyAlive(pid, label, "_resume_kilo_session", accumulated);
  if (nope) {
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    if (!isRetry && detectCloudValidationFailure(accumulated)) {
      log(`_resume_kilo_session ${logPrefix(label)} cloud validation failure detected at initial check — retrying without provider block`);
      return _resumeKiloSessionInner(workDir, label, oldCloudSessionId, { skipProvider: true, isRetry: true });
    }
    return { pid, ptyProcess, cloudSessionId: null, started: false, reason: nope };
  }

  const tuiReady = await waitForString(() => accumulated, label, 30, [
    "kilo>", "\u2502 > ", "\u276f ", "> ", "How can I help",
    "Type your message", "Enter prompt", "Send a message", "Ask anything",
    "kilo CLI", "Connected", "connected",
  ], () => reposLib.isAlive(pid));
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

  // Cloud validation failure detection (same as startKiloSession). kilo 7.4.x
  // rejects custom baseURL providers, killing the PTY. Retry without provider
  // block if we haven't already.
  if (!isRetry && detectCloudValidationFailure(accumulated)) {
    log(`_resume_kilo_session ${logPrefix(label)} cloud validation failure detected — retrying without provider block`);
    try { ptyProcess.kill(); } catch (_) {}
    try { fs.closeSync(logFd); } catch (_) {}
    LIVE_PTYS.delete(label);
    return _resumeKiloSessionInner(workDir, label, oldCloudSessionId, { skipProvider: true, isRetry: true });
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
      const entry = LIVE_PTYS.get(label);
      if (entry && !entry.remoteConnectedAt) entry.remoteConnectedAt = Date.now();
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
    // Update the bucket's cloud_session_id if a scan recovered one. The bucket
    // transitions to stopped via updateStatus() on the next /api/repos poll.
    if (exitCode !== 0) {
      dumpPtyTail("_monitor_exit", label, accumulated);
    }
    const scan = scanInternalLogs(spawnedAtMs);
    const repos = reposLib.loadRepos();
    const bucket = repos.find((r) => r.work_dir_identifier === label);
    if (bucket && scan.cloudSessionId) {
      bucket.kilo_session_id = scan.cloudSessionId;
      reposLib.saveRepos(repos);
    }
    // Consolidate datetime-named internal log files into one per day.
    try { consolidateKiloLogs(); } catch (_) {}
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
  const entry = LIVE_PTYS.get(label);
  if (!entry) return false;
  try {
    entry.pty.write(prompt + "\n");
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



module.exports = { startKiloSession, resumeKiloSession, initKiloStartup, writeRemoteControlJson, writeDefaultModel, checkGateway, scanInternalLogs, sendPromptToLive, isLive, LIVE_PTYS, writeProjectConfig, detectKiloStartupErrors, submitPromptConfirmed, checkPtyAlive, consolidateKiloLogs, detectCloudValidationFailure };