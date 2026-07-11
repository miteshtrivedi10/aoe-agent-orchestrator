const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const reposPath = path.resolve(__dirname, "../lib/repos.js");
function reloadRepos() {
  delete require.cache[require.resolve(reposPath)];
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/logger.js"))];
  return require(reposPath);
}

describe("repos", () => {
  let repos;
  let tmpDir;

  beforeEach(() => {
    mock.method(console, "log", () => {});
    tmpDir = fs.mkdtempSync("/tmp/agent-dock-repos-test-");
    repos = reloadRepos();
  });

  afterEach(() => {
    mock.restoreAll();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe("GIT_URL_RE", () => {
    it("matches .git URLs", () => {
      assert.ok(repos.GIT_URL_RE.test("https://github.com/owner/repo.git"));
      assert.ok(repos.GIT_URL_RE.test("git@github.com:owner/repo.git"));
      assert.ok(repos.GIT_URL_RE.test("https://github.com/owner/repo.git#branch"));
      assert.ok(repos.GIT_URL_RE.test("https://github.com/owner/repo.git/"));
    });
    it("rejects non-.git URLs", () => {
      assert.equal(repos.GIT_URL_RE.test("https://github.com/owner/repo"), false);
      assert.equal(repos.GIT_URL_RE.test("https://example.com"), false);
    });
  });

  describe("BRANCH_RE", () => {
    it("accepts valid branch names", () => {
      assert.ok(repos.BRANCH_RE.test("main"));
      assert.ok(repos.BRANCH_RE.test("feature/my-branch"));
      assert.ok(repos.BRANCH_RE.test("fix/issue.123"));
      assert.ok(repos.BRANCH_RE.test("dev_v2"));
    });
    it("rejects invalid branch names", () => {
      assert.equal(repos.BRANCH_RE.test(""), false);
      assert.equal(repos.BRANCH_RE.test("feature..bad"), false);
      assert.equal(repos.BRANCH_RE.test("bad branch"), false);
      assert.equal(repos.BRANCH_RE.test("branch:colon"), false);
      assert.equal(repos.BRANCH_RE.test("-leading"), false);
      assert.equal(repos.BRANCH_RE.test("branch.lock"), false);
    });
  });

  describe("bucketIdentifier / repoName", () => {
    it("repoName extracts repo basename from URL", () => {
      assert.equal(repos.repoName("https://github.com/owner/my-repo.git"), "my-repo");
      assert.equal(repos.repoName("https://github.com/owner/repo"), "repo");
      assert.equal(repos.repoName("git@github.com:org/name.git"), "name");
      assert.equal(repos.repoName("https://example.com/repo.git/"), "repo");
    });
    it("bucketIdentifier equals repoName (repo-only key, no branch suffix)", () => {
      assert.equal(repos.bucketIdentifier("https://github.com/owner/xyz.git"), "xyz");
      assert.equal(repos.bucketIdentifier("git@github.com:org/name.git"), "name");
    });
    it("same repo different branch → same identifier (per spec v2)", () => {
      const a = repos.bucketIdentifier("https://github.com/owner/xyz.git");
      const b = repos.bucketIdentifier("https://github.com/owner/xyz.git");
      assert.equal(a, b);
    });
  });

  describe("loadRepos / saveRepos", () => {
    it("loadRepos returns empty array when file missing", () => {
      const readMock = mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      assert.deepEqual(repos.loadRepos(), []);
      readMock.mock.restore();
    });
    it("loadRepos returns parsed JSON", () => {
      mock.method(fs, "readFileSync", () => JSON.stringify([{ work_dir_identifier: "abc", session_state: "running" }]));
      const result = repos.loadRepos();
      assert.deepEqual(result, [{ work_dir_identifier: "abc", session_state: "running" }]);
      mock.restoreAll();
    });
    it("saveRepos writes JSON", () => {
      const writeMock = mock.method(fs, "writeFileSync", () => {});
      repos.saveRepos([{ work_dir_identifier: "xyz" }]);
      assert.ok(writeMock.mock.callCount() >= 1);
      assert.ok(writeMock.mock.calls[0].arguments[1].includes('"work_dir_identifier": "xyz"'));
      mock.restoreAll();
    });
  });

  describe("findBucket / findBucketByRepo", () => {
    it("findBucket returns entry by work_dir_identifier", () => {
      const list = [
        { work_dir_identifier: "xyz", repo_url: "https://github.com/o/xyz.git" },
        { work_dir_identifier: "abc", repo_url: "https://github.com/o/abc.git" },
      ];
      assert.equal(repos.findBucket(list, "xyz"), list[0]);
      assert.equal(repos.findBucket(list, "nope"), null);
    });
    it("findBucketByRepo resolves via bucketIdentifier", () => {
      const list = [{ work_dir_identifier: "xyz", repo_url: "https://github.com/o/xyz.git" }];
      assert.equal(repos.findBucketByRepo(list, "https://github.com/o/xyz.git"), list[0]);
      // Same repo basename, different URL with different owner collides — we
      // surface this at checkout by comparing repo_url in server.js.
      assert.equal(repos.findBucketByRepo(list, "https://github.com/other/xyz.git"), list[0]);
    });
  });

  describe("isAlive / terminateProcess", () => {
    it("isAlive true for current process", () => {
      assert.equal(repos.isAlive(process.pid), true);
    });
    it("isAlive false for null/nonexistent pid", () => {
      assert.equal(repos.isAlive(null), false);
      assert.equal(repos.isAlive(999999), false);
    });
    it("terminateProcess is a no-op for 0/null/nonexistent", async () => {
      await repos.terminateProcess(0);
      await repos.terminateProcess(null);
      await repos.terminateProcess(999999);
    });
  });

  describe("updateStatus", () => {
    it("transitions running → stopped when pid is dead (cloud_session_id preserved)", () => {
      const list = [
        { work_dir_identifier: "a", pid: 999999, session_state: "running", kilo_session_id: "ses_keep" },
        { work_dir_identifier: "b", pid: process.pid, session_state: "running" },
        { work_dir_identifier: "c", session_state: "paused", kilo_session_id: "ses_x" },
      ];
      const result = repos.updateStatus(list);
      assert.equal(result[0].session_state, "stopped");
      assert.ok(result[0].stopped_at);
      assert.equal(result[0].pid, null);
      assert.equal(result[0].is_active_in_agent_dock, false);
      assert.equal(result[0].kilo_session_id, "ses_keep", "cloud_session_id MUST be preserved on running→stopped");
      assert.equal(result[1].session_state, "running");
      assert.equal(result[1].is_active_in_agent_dock, true);
      assert.equal(result[2].session_state, "paused", "non-running states untouched");
    });
  });

  describe("cloneUrl", () => {
    const origToken = process.env.GITHUB_TOKEN;
    afterEach(() => {
      if (origToken) process.env.GITHUB_TOKEN = origToken;
      else delete process.env.GITHUB_TOKEN;
    });
    it("returns file:// URLs unchanged", () => {
      assert.equal(repos.cloneUrl("file:///tmp/repo"), "file:///tmp/repo");
    });
    it("returns HTTPS URLs unchanged without GITHUB_TOKEN", () => {
      delete process.env.GITHUB_TOKEN;
      assert.equal(repos.cloneUrl("https://github.com/owner/repo.git"), "https://github.com/owner/repo.git");
    });
    it("embeds GITHUB_TOKEN in HTTPS URLs", () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      assert.ok(repos.cloneUrl("https://github.com/owner/repo.git").startsWith("https://ghp_test123@"));
    });
    it("returns non-http URLs unchanged", () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      assert.equal(repos.cloneUrl("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
    });
  });

  describe("newBucket factory", () => {
    it("creates a bucket with required schema fields and defaults", () => {
      const b = repos.newBucket({
        repoUrl: "https://github.com/o/xyz.git",
        branch: "main",
        workDir: "/data/repos/xyz",
        workDirId: "xyz",
      });
      assert.equal(b.work_dir_identifier, "xyz");
      assert.equal(b.repo_name, "xyz");
      assert.equal(b.branch, "main");
      assert.equal(b.work_dir, "/data/repos/xyz");
      assert.equal(b.session_state, "running");
      assert.equal(b.kilo_session_id, null);
      assert.equal(b.pid, null);
      assert.equal(b.is_active_in_agent_dock, false);
      assert.equal(b.cloud_session_status, "unknown");
      assert.ok(b.started_at);
      assert.equal(b.paused_at, null);
      assert.equal(b.resumed_at, null);
      assert.equal(b.stopped_at, null);
      assert.equal(b.killed_at, null);
      assert.equal(b.resume_count, 0);
      assert.equal(b.cloud_session_deleted, false);
      assert.equal(b.last_warning, null);
    });
    it("default branch is 'main' when none provided", () => {
      const b = repos.newBucket({
        repoUrl: "https://github.com/o/xyz.git",
        branch: "",
        workDir: "/data/repos/xyz",
        workDirId: "xyz",
      });
      assert.equal(b.branch, "main");
    });
  });

  describe("deleteCloudSession", () => {
    it("returns ok when kiloSessionId is null/empty", () => {
      const r1 = repos.deleteCloudSession(null);
      const r2 = repos.deleteCloudSession("");
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
    });
    it("treats 'Session not found' from kilo as ok (idempotent)", () => {
      const execMock = mock.method(require("child_process"), "execFileSync", () => {
        const e = new Error("Error: Session not found: ses_xxx");
        throw e;
      });
      const r = repos.deleteCloudSession("ses_xxx");
      assert.equal(r.ok, true);
      assert.equal(r.reason, "already_gone");
      execMock.mock.restore();
    });
    it("returns ok when kilo exits cleanly", () => {
      const execMock = mock.method(require("child_process"), "execFileSync", () => "deleted");
      const r = repos.deleteCloudSession("ses_xxx");
      assert.equal(r.ok, true);
      assert.equal(r.reason, "deleted");
      execMock.mock.restore();
    });
    it("returns not-ok on other failures", () => {
      const execMock = mock.method(require("child_process"), "execFileSync", () => {
        throw new Error("kilo crashed: some other reason");
      });
      const r = repos.deleteCloudSession("ses_xxx");
      assert.equal(r.ok, false);
      execMock.mock.restore();
    });
  });

  describe("checkoutRepo (logging hygiene)", () => {
    it("logs repo_url (not tokenized URL)", () => {
      const logSpy = mock.method(console, "log", () => {});
      mock.method(require("child_process"), "execFileSync", () => "");
      mock.method(fs, "readdirSync", () => [".git", "README.md"]);
      mock.method(fs, "mkdirSync", () => {});
      const origToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_secret123";
      try {
        repos.checkoutRepo("https://github.com/test/repo.git", "main", "repo");
        const logCalls = logSpy.mock.calls.map(c => c.arguments.join(" "));
        const urlLog = logCalls.find(l => l.includes("url="));
        assert.ok(urlLog, "should log the URL");
        assert.ok(!urlLog.includes("ghp_secret123"), "must NOT log the token");
      } finally {
        process.env.GITHUB_TOKEN = origToken;
        mock.restoreAll();
      }
    });

    it("strips token from clone error message", () => {
      process.env.GITHUB_TOKEN = "ghp_secret456";
      mock.method(require("child_process"), "execFileSync", () => {
        throw new Error("fatal: could not read from https://ghp_secret456@github.com/test/repo.git");
      });
      mock.method(fs, "mkdirSync", () => {});
      const logSpy = mock.method(console, "log", () => {});
      try {
        repos.checkoutRepo("https://github.com/test/repo.git", "main", "repo");
      } catch (_) {
        // expected — clone failed
      }
      const logCalls = logSpy.mock.calls.map(c => c.arguments.join(" "));
      const errorLog = logCalls.find(l => l.includes("clone failed"));
      assert.ok(errorLog);
      assert.ok(!errorLog.includes("ghp_secret456"), "must strip token");
      assert.ok(errorLog.includes("https://***@"), "should replace token with ***");
      delete process.env.GITHUB_TOKEN;
      mock.restoreAll();
    });
  });

  describe("removeWorkDirFast", () => {
    async function waitForGone(p, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!fs.existsSync(p)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return !fs.existsSync(p);
    }

    it("renames away immediately and removes in background", async () => {
      const workDir = fs.mkdtempSync(path.join(tmpDir, "wd-"));
      fs.writeFileSync(path.join(workDir, "file.txt"), "data");
      const r = repos.removeWorkDirFast(workDir);
      assert.equal(r.launched, true);
      assert.equal(r.reason, "rename");
      // Original path is gone from the namespace instantly (no blocking).
      assert.equal(fs.existsSync(workDir), false, "original dir must vanish immediately");
      // Background `rm` eventually removes the trash path.
      const gone = await waitForGone(r.trashPath);
      assert.ok(gone, "background rm should remove the trash dir");
    });

    it("returns missing when work dir does not exist", () => {
      const r = repos.removeWorkDirFast(path.join(tmpDir, "does-not-exist"));
      assert.equal(r.launched, false);
      assert.equal(r.reason, "missing");
    });

    it("falls back to in-place rm and never throws", async () => {
      const workDir = fs.mkdtempSync(path.join(tmpDir, "wd2-"));
      // Force rename to fail by making the trash target collide-prone:
      // simulate by mocking renameSync to throw, then ensure spawn path runs.
      mock.method(fs, "renameSync", () => { throw new Error("EXDEV"); });
      const r = repos.removeWorkDirFast(workDir);
      assert.equal(r.launched, true);
      assert.equal(r.reason, "inplace");
      mock.restoreAll();
      const gone = await waitForGone(workDir);
      assert.ok(gone, "in-place rm should remove the dir");
    });
  });
});
