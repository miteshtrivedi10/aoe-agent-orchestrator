const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { log, logPrefix, sleep } = require("./logger");

const SESSIONS_FILE = "/data/sessions.json";
const REPOS_DIR = "/data/repos";

const GIT_URL_RE = /\.git(?:\/?|#.*)?$/i;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,255}$/;

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

async function terminateProcess(pid) {
  if (!pid || !isAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (_) {
    try { process.kill(pid, "SIGTERM"); } catch (_) {}
  }
  const deadline = Date.now() + 5000;
  while (isAlive(pid) && Date.now() < deadline) {
    await sleep(200);
  }
  if (isAlive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch (_) {
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
    await sleep(500);
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
  // For public repos or repos without GITHUB_TOKEN, use the URL as-is.
  // For private repos with GITHUB_TOKEN set, embed it in the URL.
  // WARNING: the returned URL CONTAINS THE TOKEN. Never log it. Never expose it
  // in error messages. The caller (checkoutRepo) must handle errors safely.
  if (raw.startsWith("file://")) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/^https?:\/\//, (m) => {
      const token = process.env.GITHUB_TOKEN;
      return token ? `https://${token}@` : m;
    });
  }
  return raw;
}

function repoName(raw) {
  return raw.replace(/\/$/, "").replace(/\.git$/, "").split("/").pop();
}

function checkoutRepo(repoUrl, branch, sessionId) {
  const repo = repoName(repoUrl);
  const ws = path.join(REPOS_DIR, `${repo}__${sessionId}`);
  const label = sessionId;

  log(`_checkout_repo ${logPrefix(label)} url=${repoUrl} branch=${branch} dir=${ws}`);

  // cloneUrl may embed GITHUB_TOKEN in the URL. Never log the tokenized URL.
  // If git fails, strip the token from the error message before logging.
  const url = cloneUrl(repoUrl);
  try {
    execFileSync("git", ["clone", url, ws], {
      timeout: 300000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const safeMsg = e.message.replace(/https:\/\/[^@]+@/g, "https://***@");
    log(`_checkout_repo ${logPrefix(label)} clone failed: ${safeMsg}`);
    throw e;
  }

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

  const entries = fs.readdirSync(ws);
  log(`_checkout_repo ${logPrefix(label)} entries: ${entries.join(", ")}`);
  return { workDir: ws };
}

module.exports = {
  SESSIONS_FILE,
  REPOS_DIR,
  GIT_URL_RE,
  BRANCH_RE,
  loadSessions,
  saveSessions,
  isAlive,
  terminateProcess,
  updateStatus,
  cloneUrl,
  repoName,
  checkoutRepo,
};