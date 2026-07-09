const crypto = require("crypto");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const rateLimit = require("express-rate-limit");
const { log, logPrefix, stripAnsi, sanitizeLog } = require("./logger");

function logKiloVersion(context) {
  try {
    const result = cp.execFileSync("kilo", ["--version"], { encoding: "utf8", timeout: 5000 });
    log(`${context} kilo --version: ${(result || "").trim()}`);
  } catch (e) {
    log(`${context} kilo --version unavailable: ${e.message}`);
  }
}

const RAW_TOKEN = (process.env.AGENT_DOCK_API_TOKEN || "").trim();
const API_TOKEN = RAW_TOKEN || crypto.randomBytes(24).toString("hex");
const TOKEN_IS_AUTOGEN = !RAW_TOKEN;
const RATE_LIMIT_DISABLED = (process.env.AGENT_DOCK_RATE_LIMIT || "").toLowerCase() === "off";

const KILO_DIR = "/data/kilo";

if (TOKEN_IS_AUTOGEN) {
  log(`boot AGENT_DOCK_API_TOKEN not set — generated ephemeral token (length=${API_TOKEN.length})`);
} else {
  log(`boot AGENT_DOCK_API_TOKEN loaded from env (${API_TOKEN.length} chars; auto-gen=false)`);
}
if (RATE_LIMIT_DISABLED) log("boot AGENT_DOCK_RATE_LIMIT=off — rate limits disabled (test mode only)");

function authGate(req, res, next) {
  // Primary: Authorization: Bearer <token>
  // Secondary: X-Agent-Dock-Token: <token> (for use behind HF private-space proxy
  // which consumes the Authorization header for HF token auth)
  const hdr = req.get("authorization");
  const altHdr = req.get("x-agent-dock-token");
  const rawToken = hdr || (altHdr ? `Bearer ${altHdr}` : null);

  if (!rawToken) {
    res.set("WWW-Authenticate", 'Bearer realm="agent-dock"');
    return res.status(401).json({
      error: "missing Authorization header",
      hint: "send: Authorization: Bearer <AGENT_DOCK_API_TOKEN> or X-Agent-Dock-Token: <AGENT_DOCK_API_TOKEN>",
    });
  }
  const m = /^Bearer\s+(.+)$/i.exec(rawToken);
  if (!m) {
    res.set("WWW-Authenticate", 'Bearer realm="agent-dock"');
    return res.status(401).json({
      error: "Authorization header is not a Bearer token",
      received_scheme: rawToken.split(/\s+/)[0],
      hint: "must be: Authorization: Bearer <AGENT_DOCK_API_TOKEN>",
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

function inspectAuth() {
  const result = {
    file_exists: false,
    file_size: 0,
    file_keys: [],
    configured_type: null,
    detected_type: null,
    has_access: false,
    has_refresh: false,
    has_token: false,
    has_key: false,
    expires_at: null,
    expires_unix_ms: null,
    expired: false,
    valid: false,
    reason: "no auth.json found",
  };
  const authPath = path.join(KILO_DIR, "auth.json");
  try {
    const st = fs.statSync(authPath);
    result.file_exists = true;
    result.file_size = st.size;
  } catch (_) {
    if (process.env.KILO_API_KEY) {
      result.detected_type = "env-var";
      result.has_key = true;
      result.valid = true;
      result.reason = "ok (env-var KILO_API_KEY)";
    }
    return result;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const kilo = raw.kilo || raw;
    result.file_keys = Object.keys(raw);
    result.configured_type = kilo.type || null;
    result.detected_type = kilo.type || null;
    result.has_access = !!kilo.access;
    result.has_refresh = !!kilo.refresh;
    result.has_token = !!kilo.token;
    result.has_key = !!kilo.key;
    if (kilo.expires) {
      result.expires_at = kilo.expires;
      result.expires_unix_ms = new Date(kilo.expires).getTime();
      result.expired = result.expires_unix_ms < Date.now();
    }
    if (kilo.type === "oauth" && kilo.access) {
      result.valid = !result.expired;
      result.reason = result.valid ? "ok" : "expired oauth token";
    } else if (kilo.type === "api" && kilo.key) {
      result.valid = true;
      result.reason = "ok";
    } else if (kilo.type === "wellknown" && kilo.token) {
      result.valid = true;
      result.reason = "ok";
    } else {
      result.reason = `unknown auth type: ${kilo.type || "?"}`;
    }
    if (result.valid && result.detected_type === "oauth") {
      result.token = kilo.access;
    }
  } catch (e) {
    result.reason = `auth.json parse error: ${e.message}`;
  }
  return result;
}

function writeAuthJson() {
  const authPath = path.join(KILO_DIR, "auth.json");
  const key = process.env.KILO_API_KEY || process.env.KILO_AUTH_TOKEN;
  if (!key) return;
  try {
    const st = fs.statSync(authPath);
    if (st.size > 10) {
      const kilo = JSON.parse(fs.readFileSync(authPath, "utf8"));
      log(`_startup_auth auth.json already present type=${kilo.type || "?"} — keeping device-flow credentials`);
      return;
    }
  } catch (_) {}
  const data = {
    kilo: {
      type: "api",
      key: key,
    },
  };
  fs.writeFileSync(authPath, JSON.stringify(data, null, 2));
  log(`_startup_auth written type=${data.kilo?.type || "?"} source=KILO_API_KEY env`);
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
    logKiloVersion("_run_device_auth");
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

          if (/login successful/i.test(line) || /done/i.test(line)) {
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
      if (!DEVICE_AUTH.url) {
        const urlMatch = buf.match(/https:\/\/app\.kilo\.ai\/\S+/);
        if (urlMatch) DEVICE_AUTH.url = urlMatch[0].replace(/\u2502/g, "").trim();
      }
      if (!DEVICE_AUTH.code) {
        const codeMatch = buf.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        if (codeMatch) DEVICE_AUTH.code = codeMatch[0];
      }
      log("_run_device_auth device-flow login succeeded — auth valid, TUI sessions will auto-connect to cloud");
      return { success: true };
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
  return { success: false };
}

module.exports = {
  API_TOKEN,
  TOKEN_IS_AUTOGEN,
  RATE_LIMIT_DISABLED,
  KILO_DIR,
  authGate,
  makeLimiter,
  readLimiter,
  writeLimiter,
  authLimiter,
  inspectAuth,
  writeAuthJson,
  DEVICE_AUTH,
  runDeviceAuth,
};