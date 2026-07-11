const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const { log, logPrefix, sleep } = require("./logger");

// Single global registry of repo buckets. Each (repo) entry has exactly one
// work directory and at most one live kilo session. Branch is informational —
// captured at checkout and best-effort refreshed from `git rev-parse` while the
// bucket is running — and is NOT part of the bucket key.
const REPOS_FILE = "/data/repos.json";
const REPOS_DIR = "/data/repos";

const GIT_URL_RE = /\.git(?:\/?|#.*)?$/i;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]{1,255}$/;

// Valid session states for a bucket.
//   running → InProgress
//   paused  → Paused (PTY killed, cloud_session_id preserved)
//   stopped → Stopped (PTY died on its own, cloud_session_id preserved)
//   killed  → Killed (PTY killed + `kilo session delete` called; work dir kept)
const STATES = new Set(["running", "paused", "stopped", "killed"]);

// ── Registry I/O ────────────────────────────────────────────────────────

function loadRepos() {
  try {
    return JSON.parse(fs.readFileSync(REPOS_FILE, "utf8"));
  } catch (_) {
    return [];
  }
}

function saveRepos(repos) {
  fs.writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
}

function findBucket(repos, workDirId) {
  return repos.find((r) => r.work_dir_identifier === workDirId) || null;
}

function findBucketByRepo(repos, repoUrl) {
  const id = bucketIdentifier(repoUrl);
  return findBucket(repos, id);
}

// ── Identifier ──────────────────────────────────────────────────────────

// The work_dir_identifier is the repo basename (e.g. "xyz" for
// "https://github.com/owner/xyz.git"). It's the primary key of the registry
// and the directory name under /data/repos. Two repos with the same basename
// on different owners collide — we detect this at checkout and refuse.
function bucketIdentifier(repoUrl) {
  return repoName(repoUrl);
}

// ── Process liveness (moved from sessions.js) ──────────────────────────

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
    try {
      process.kill(-pid, "SIGKILL");
    } catch (_) {
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
    }
    await sleep(500);
  }
}

// ── updateStatus ────────────────────────────────────────────────────────

// Walks the registry. For each bucket in `running` state whose pid is no
// longer alive, transitions to `stopped` and stamps `stopped_at`. The cloud
// session id is preserved so Start can re-attach if the cloud session
// outlived the local PTY. Also best-effort refreshes `branch` for running
// buckets via `git rev-parse --abbrev-ref HEAD` in the work dir (silent on
// failure).
function updateStatus(repos) {
  for (const r of repos) {
    if (r.session_state !== "running") continue;
    const pid = r.pid || 0;
    const alive = pid ? isAlive(pid) : false;
    if (alive) {
      r.is_active_in_agent_dock = true;
      refreshBranch(r);
    } else {
      log(`_update_status pid=${pid} DEAD, marking stopped`);
      r.session_state = "stopped";
      r.stopped_at = new Date().toISOString();
      r.pid = null;
      r.is_active_in_agent_dock = false;
    }
  }
  return repos;
}

// Best-effort branch refresh. Reads `git rev-parse --abbrev-ref HEAD` in the
// work dir. On any failure leaves `branch` unchanged. Detached HEAD returns
// "HEAD" — we surface that as-is so the user can see the work dir is in a
// detached state.
function refreshBranch(r) {
  if (!r.work_dir || !fs.existsSync(r.work_dir)) return;
  try {
    const out = child_process.execFileSync("git", ["-C", r.work_dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) r.branch = out;
  } catch (_) {
    // Silent — branch is informational, not a constraint.
  }
}

// ── URL parsing / clone (moved from sessions.js) ───────────────────────

function cloneUrl(raw) {
  // For public repos or repos without GITHUB_TOKEN, use the URL as-is.
  // For private repos with GITHUB_TOKEN set, embed it in the URL.
  // WARNING: the returned URL CONTAINS THE TOKEN. Never log it. Never expose
  // it in error messages. The caller (checkoutRepo) must handle errors
  // safely.
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

function checkoutRepo(repoUrl, branch, workDirId) {
  const ws = path.join(REPOS_DIR, workDirId);
  log(`_checkout_repo ${logPrefix(workDirId)} url=${repoUrl} branch=${branch} dir=${ws}`);

  const url = cloneUrl(repoUrl);
  try {
    child_process.execFileSync("git", ["clone", url, ws], {
      timeout: 300000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const safeMsg = e.message.replace(/https:\/\/[^@]+@/g, "https://***@");
    log(`_checkout_repo ${logPrefix(workDirId)} clone failed: ${safeMsg}`);
    throw e;
  }

  try {
    child_process.execFileSync("git", ["-C", ws, "checkout", branch], {
      timeout: 30000,
      stdio: "ignore",
    });
  } catch (_) {
    log(`_checkout_repo ${logPrefix(workDirId)} branch '${branch}' not present, creating from HEAD`);
    child_process.execFileSync("git", ["-C", ws, "checkout", "-b", branch], {
      timeout: 30000,
      stdio: "ignore",
    });
  }

  const entries = fs.readdirSync(ws);
  log(`_checkout_repo ${logPrefix(workDirId)} entries: ${entries.join(", ")}`);

  // Sanitize `.git/hooks/` after clone. Git treats ANY file in the hooks
  // directory matching a hook name as an executable hook and tries to exec()
  // it. A stray directory (e.g. a force-committed build artifact named
  // `pre-commit`) crashes every commit with "cannot exec: Permission denied".
  // Remove all entries that aren't regular executable files or symlinks —
  // only sample files (pre-commit.sample) or real hook scripts should remain.
  const hooksDir = path.join(ws, ".git", "hooks");
  try {
    for (const name of fs.readdirSync(hooksDir)) {
      const full = path.join(hooksDir, name);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        fs.rmSync(full, { recursive: true, force: true });
        log(`_checkout_repo ${logPrefix(workDirId)} removed stray hooks entry: ${name}`);
      }
    }
  } catch (_) { /* hooks dir absent — nothing to sanitize */ }

  return { workDir: ws };
}

// ── Cloud session delete ───────────────────────────────────────────────

// Wraps `kilo session delete <id>`. Best-effort — if the cloud session is
// already gone (deleted from the Cloud Dashboard out-of-band), kilo returns
// "Session not found" and we treat that as success. Idempotent. Never
// throws — failures are logged and returned. 10s timeout so a hung kilo call
// can't block kill/delete.
function deleteCloudSession(kiloSessionId) {
  if (!kiloSessionId) return { ok: true, reason: "no kilo_session_id" };
  try {
    const out = child_process.execFileSync("kilo", ["session", "delete", kiloSessionId], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    log(`_delete_cloud_session ${kiloSessionId} kilo exited cleanly: ${out.trim().slice(0, 200)}`);
    return { ok: true, reason: "deleted" };
  } catch (e) {
    const msg = (e.message || "").toString();
    if (/session not found/i.test(msg) || /not found/i.test(msg)) {
      log(`_delete_cloud_session ${kiloSessionId} already gone (not found) — treating as ok`);
      return { ok: true, reason: "already_gone" };
    }
    log(`_delete_cloud_session ${kiloSessionId} FAILED: ${msg.slice(0, 300)}`);
    return { ok: false, reason: "kilo session delete failed" };
  }
}

// ── Fast async work-dir removal ────────────────────────────────────────

// Removes a work directory without blocking the caller. Renames the dir to a
// unique trash sibling (atomic, same-filesystem, near-instant) so it vanishes
// from the namespace immediately, then spawns a DETACHED `rm -rf` to clean the
// trash off the event loop. The detached process is reparented to init, so it
// keeps running even if this Node process crashes or restarts — deletion is
// guaranteed to complete. `-f` makes `rm` ignore undeletable/busy files, so it
// never hangs. If rename fails (e.g. EXDEV / cross-filesystem), it falls back
// to detaching `rm -rf` directly on the original path. Returns which path the
// background `rm` was launched against (or "missing" if there was nothing to
// remove). Never throws.
function removeWorkDirFast(workDir) {
  if (!workDir || !fs.existsSync(workDir)) {
    return { launched: false, reason: "missing", trashPath: null };
  }
  const parent = path.dirname(workDir);
  const base = path.basename(workDir);
  const trashPath = path.join(parent, `.${base}.${process.pid}.${Date.now()}.trash`);
  let target = trashPath;
  try {
    fs.renameSync(workDir, trashPath);
  } catch (e) {
    // Cross-filesystem (EXDEV) or other rename failure — delete in place.
    target = workDir;
    log(`removeWorkDirFast rename failed for ${workDir}: ${e.message} — deleting in place`);
  }
  try {
    const child = child_process.spawn("rm", ["-rf", target], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      log(`removeWorkDirFast rm error for ${target}: ${err.message}`);
    });
    child.unref();
    return { launched: true, reason: target === trashPath ? "rename" : "inplace", trashPath: target };
  } catch (e) {
    // Spawn impossible (no `rm`, out of processes) — synchronously finish.
    log(`removeWorkDirFast spawn failed for ${target}: ${e.message} — falling back to sync rm`);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
    return { launched: true, reason: "sync-fallback", trashPath: target };
  }
}

// ── Bucket factory ─────────────────────────────────────────────────────

function newBucket({ repoUrl, branch, workDir, workDirId }) {
  return {
    work_dir_identifier: workDirId,
    repo_url: repoUrl,
    repo_name: repoName(repoUrl),
    branch: branch || "main",
    work_dir: workDir,
    kilo_session_id: null,
    pid: null,
    is_active_in_agent_dock: false,
    cloud_session_status: "unknown", // unknown | active | deleted
    session_state: "running",
    started_at: new Date().toISOString(),
    paused_at: null,
    resumed_at: null,
    stopped_at: null,
    killed_at: null,
    resume_count: 0,
    cloud_session_deleted: false,
    last_warning: null,
  };
}

module.exports = {
  REPOS_FILE,
  REPOS_DIR,
  GIT_URL_RE,
  BRANCH_RE,
  STATES,
  loadRepos,
  saveRepos,
  findBucket,
  findBucketByRepo,
  bucketIdentifier,
  isAlive,
  terminateProcess,
  updateStatus,
  refreshBranch,
  cloneUrl,
  repoName,
  checkoutRepo,
  deleteCloudSession,
  removeWorkDirFast,
  newBucket,
};
