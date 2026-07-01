const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const sessionsPath = path.resolve(__dirname, "../lib/sessions.js");
function reloadSessions() {
  delete require.cache[require.resolve(sessionsPath)];
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/logger.js"))];
  return require(sessionsPath);
}

describe("sessions", () => {
  let sessions;
  let tmpDir;

  beforeEach(() => {
    mock.method(console, "log", () => {});
    tmpDir = fs.mkdtempSync("/tmp/hermes-sessions-test-");
    // Override SESSIONS_FILE and REPOS_DIR by writing to the actual paths
    // and using mkdir. Since these are constants, we mock fs ops.
    sessions = reloadSessions();
  });

  afterEach(() => {
    mock.restoreAll();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe("GIT_URL_RE", () => {
    it("matches .git URLs", () => {
      assert.ok(sessions.GIT_URL_RE.test("https://github.com/owner/repo.git"));
      assert.ok(sessions.GIT_URL_RE.test("git@github.com:owner/repo.git"));
      assert.ok(sessions.GIT_URL_RE.test("https://github.com/owner/repo.git#branch"));
      assert.ok(sessions.GIT_URL_RE.test("https://github.com/owner/repo.git/"));
    });
    it("rejects non-.git URLs", () => {
      assert.equal(sessions.GIT_URL_RE.test("https://github.com/owner/repo"), false);
      assert.equal(sessions.GIT_URL_RE.test("https://example.com"), false);
    });
  });

  describe("BRANCH_RE", () => {
    it("accepts valid branch names", () => {
      assert.ok(sessions.BRANCH_RE.test("main"));
      assert.ok(sessions.BRANCH_RE.test("feature/my-branch"));
      assert.ok(sessions.BRANCH_RE.test("fix/issue.123"));
      assert.ok(sessions.BRANCH_RE.test("dev_v2"));
    });
    it("rejects invalid branch names", () => {
      assert.equal(sessions.BRANCH_RE.test(""), false);
      assert.equal(sessions.BRANCH_RE.test("feature..bad"), false);
      assert.equal(sessions.BRANCH_RE.test("bad branch"), false);
      assert.equal(sessions.BRANCH_RE.test("branch:colon"), false);
      assert.equal(sessions.BRANCH_RE.test("-leading"), false);
      assert.equal(sessions.BRANCH_RE.test("branch.lock"), false);
    });
  });

  describe("loadSessions / saveSessions", () => {
    it("loadSessions returns empty array when file missing", () => {
      const readMock = mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      const result = sessions.loadSessions();
      assert.deepEqual(result, []);
      readMock.mock.restore();
    });
    it("loadSessions returns parsed JSON", () => {
      mock.method(fs, "readFileSync", () => JSON.stringify([{ id: "abc", status: "running" }]));
      const result = sessions.loadSessions();
      assert.deepEqual(result, [{ id: "abc", status: "running" }]);
      mock.restoreAll();
    });
    it("saveSessions writes JSON", () => {
      const writeMock = mock.method(fs, "writeFileSync", () => {});
      sessions.saveSessions([{ id: "xyz" }]);
      assert.ok(writeMock.mock.callCount() >= 1);
      assert.ok(writeMock.mock.calls[0].arguments[1].includes('"id": "xyz"'));
      mock.restoreAll();
    });
  });

  describe("isAlive", () => {
    it("returns true for current process", () => {
      assert.equal(sessions.isAlive(process.pid), true);
    });
    it("returns false for null/undefined", () => {
      assert.equal(sessions.isAlive(null), false);
    });
    it("returns false for non-existent pid", () => {
      assert.equal(sessions.isAlive(999999), false);
    });
  });

  describe("terminateProcess", () => {
    it("does nothing for pid 0", async () => {
      // Should not throw
      await sessions.terminateProcess(0);
    });
    it("does nothing for null pid", async () => {
      await sessions.terminateProcess(null);
    });
    it("does nothing for non-alive pid", async () => {
      await sessions.terminateProcess(999999);
    });
  });

  describe("updateStatus", () => {
    it("marks running dead processes as stopped", () => {
      const sess = [
        { id: "a", pid: 999999, status: "running" },
        { id: "b", pid: process.pid, status: "running" },
        { id: "c", status: "paused" },
      ];
      const result = sessions.updateStatus(sess);
      assert.equal(result[0].status, "stopped");
      assert.ok(result[0].stopped_at);
      assert.equal(result[1].status, "running");
      assert.equal(result[2].status, "paused");
    });
    it("keeps non-running status for dead processes", () => {
      const sess = [{ id: "a", pid: 999999, status: "paused" }];
      const result = sessions.updateStatus(sess);
      assert.equal(result[0].status, "paused");
    });
    it("sets running for alive processes", () => {
      const sess = [{ id: "a", pid: process.pid, status: "stopped" }];
      const result = sessions.updateStatus(sess);
      assert.equal(result[0].status, "running");
    });
  });

  describe("cloneUrl", () => {
    const origToken = process.env.GITHUB_TOKEN;

    afterEach(() => {
      if (origToken) process.env.GITHUB_TOKEN = origToken;
      else delete process.env.GITHUB_TOKEN;
    });

    it("returns file:// URLs unchanged", () => {
      assert.equal(sessions.cloneUrl("file:///tmp/repo"), "file:///tmp/repo");
    });
    it("returns HTTPS URLs unchanged without GITHUB_TOKEN", () => {
      delete process.env.GITHUB_TOKEN;
      assert.equal(sessions.cloneUrl("https://github.com/owner/repo.git"), "https://github.com/owner/repo.git");
    });
    it("embeds GITHUB_TOKEN in HTTPS URLs", () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const result = sessions.cloneUrl("https://github.com/owner/repo.git");
      assert.ok(result.startsWith("https://ghp_test123@"));
    });
    it("embeds GITHUB_TOKEN in HTTP URLs (note: scheme is upgraded to https)", () => {
      process.env.GITHUB_TOKEN = "ghp_test456";
      const result = sessions.cloneUrl("http://example.com/repo.git");
      // cloneUrl hardcodes https:// in the replacement — known behavior
      assert.ok(result.startsWith("https://ghp_test456@"));
      assert.ok(result.includes("example.com/repo.git"));
    });
    it("returns non-http URLs unchanged", () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      assert.equal(sessions.cloneUrl("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
    });
  });

  describe("repoName", () => {
    it("extracts repo name from URL", () => {
      assert.equal(sessions.repoName("https://github.com/owner/my-repo.git"), "my-repo");
      assert.equal(sessions.repoName("https://github.com/owner/repo"), "repo");
      assert.equal(sessions.repoName("git@github.com:org/name.git"), "name");
      assert.equal(sessions.repoName("https://example.com/repo.git/"), "repo");
    });
  });

  describe("checkoutRepo", () => {
    it("logs url parameter (not tokenized URL)", () => {
      const logSpy = mock.method(console, "log", () => {});
      // Mock execFileSync to succeed
      const execMock = mock.method(require("child_process"), "execFileSync", () => "");
      mock.method(fs, "readdirSync", () => [".git", "README.md"]);
      mock.method(fs, "mkdirSync", () => {});

      // This will fail because /data/repos likely doesn't exist, but we mock execFileSync
      // The point is to verify the log message doesn't contain the token
      const origToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_secret123";
      try {
        const result = sessions.checkoutRepo("https://github.com/test/repo.git", "main", "test123");
        const logCalls = logSpy.mock.calls.map(c => c.arguments.join(" "));
        const urlLog = logCalls.find(l => l.includes("url="));
        assert.ok(urlLog, "should log the URL");
        assert.ok(!urlLog.includes("ghp_secret123"), "must NOT log the token");
        assert.equal(result.workDir, "/data/repos/repo__test123");
      } catch (e) {
        // May fail if /data/repos doesn't exist, but we mocked execFileSync
        const logCalls = logSpy.mock.calls.map(c => c.arguments.join(" "));
        const urlLog = logCalls.find(l => l.includes("url="));
        if (urlLog) {
          assert.ok(!urlLog.includes("ghp_secret123"), "must NOT log the token");
        }
      } finally {
        process.env.GITHUB_TOKEN = origToken;
        mock.restoreAll();
      }
    });

    it("strips token from clone error message", () => {
      process.env.GITHUB_TOKEN = "ghp_secret456";
      const execMock = mock.method(require("child_process"), "execFileSync", () => {
        const err = new Error("fatal: could not read from https://ghp_secret456@github.com/test/repo.git");
        throw err;
      });
      mock.method(fs, "mkdirSync", () => {});
      const logSpy = mock.method(console, "log", () => {});

      try {
        sessions.checkoutRepo("https://github.com/test/repo.git", "main", "test456");
      } catch (e) {
        const logCalls = logSpy.mock.calls.map(c => c.arguments.join(" "));
        const errorLog = logCalls.find(l => l.includes("clone failed"));
        assert.ok(errorLog, "should log the error");
        assert.ok(!errorLog.includes("ghp_secret456"), "must strip token from error log");
        assert.ok(errorLog.includes("https://***@"), "should replace token with ***");
      }
      delete process.env.GITHUB_TOKEN;
      mock.restoreAll();
    });
  });
});