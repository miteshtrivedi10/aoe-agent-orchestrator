const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const http = require("http");

const serverPath = path.resolve(__dirname, "../server.js");

function reloadServer(envOverrides = {}) {
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const mod of ["/server.js", "/lib/logger.js", "/lib/auth.js", "/lib/repos.js", "/lib/kilo.js"]) {
    const full = path.resolve(__dirname, ".." + mod);
    delete require.cache[require.resolve(full)];
  }
  return require(serverPath);
}

function req(url, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, url);
    const options = {
      hostname: fullUrl.hostname,
      port: fullUrl.port,
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers: { ...headers },
    };
    if (body) options.headers["Content-Type"] = "application/json";
    const r = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (_) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("server", () => {
  let server;
  let baseUrl;

  beforeEach((_, done) => {
    const cp = require("child_process");
    mock.method(cp, "execFileSync", () => "7.3.54");
    mock.method(cp, "spawn", () => {
      const child = new (require("events").EventEmitter)();
      child.pid = 99999;
      child.stdout = new (require("events").EventEmitter)();
      child.stderr = new (require("events").EventEmitter)();
      child.unref = () => {};
      child.kill = () => {};
      return child;
    });
    // Mock node-pty's spawn so /api/auth/login and startKiloSession don't
    // launch a real kilo process (which would open a browser auth page).
    const pty = require("node-pty");
    mock.method(pty, "spawn", () => {
      const fake = new (require("events").EventEmitter)();
      fake.pid = 99999;
      fake.write = () => {};
      fake.kill = () => {};
      fake.resize = () => {};
      fake.on = fake.addListener;
      return fake;
    });
    // Default to valid auth (KILO_API_KEY set) so auth pre-flight lets
    // requests through. Tests that explicitly check the 409 path can
    // override by deleting process.env.KILO_API_KEY in the test body.
    process.env.KILO_API_KEY = "kilo_test_key";
    mock.method(fs, "mkdirSync", () => {});
    const origReadFileSync = fs.readFileSync;
    mock.method(fs, "readFileSync", (fp, ...args) => {
      if (fp && fp.toString().includes("templates/index.html")) {
        return "<html><script>window.__AGENT_DOCK_TOKEN__=\"\";</script></html>";
      }
      return origReadFileSync(fp, ...args);
    });
    mock.method(fs, "writeFileSync", () => {});
    mock.method(fs, "readdirSync", () => []);
    mock.method(fs, "statSync", (fp) => {
      if (fp && fp.toString().includes("auth.json")) throw new Error("ENOENT");
      throw new Error("ENOENT");
    });
    mock.method(console, "log", () => {});
    global.fetch = mock.fn(() => Promise.resolve({ status: 200 }));

    const app = reloadServer({
      AGENT_DOCK_API_TOKEN: "test-server-token",
      AGENT_DOCK_RATE_LIMIT: "off",
      AGENT_DOCK_DEFAULT_MODEL: "kilo/kilo-auto/free",
    });

    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterEach((_, done) => {
    mock.restoreAll();
    delete global.fetch;
    delete process.env.KILO_API_KEY;
    if (server) {
      server.close(() => done());
    } else {
      done();
    }
  });

  describe("GET /", () => {
    it("returns HTML", async () => {
      const res = await req(baseUrl, "GET", "/");
      assert.equal(res.status, 200);
      assert.ok(res.body.includes("__AGENT_DOCK_TOKEN__"));
    });
  });

  describe("GET /api/status", () => {
    it("returns version and model info; reports repo_count (not session_count)", async () => {
      // patch loadRepos to return 2 buckets
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [{ work_dir_identifier: "a" }, { work_dir_identifier: "b" }]);
      const res = await req(baseUrl, "GET", "/api/status");
      assert.equal(res.status, 200);
      assert.equal(res.body.kilo_version, "7.3.54");
      assert.equal(res.body.daemon_running, false);
      assert.equal(res.body.repo_count, 2);
      assert.ok(!("session_count" in res.body), "must not expose legacy session_count");
      assert.ok(res.body.api_security.token_required);
    });
  });

  describe("GET /api/repos", () => {
    it("returns 401 without auth", async () => {
      const res = await req(baseUrl, "GET", "/api/repos");
      assert.equal(res.status, 401);
    });
    it("returns repo buckets array with valid auth", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [{ work_dir_identifier: "xyz", session_state: "running" }]);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "updateStatus", (r) => r);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "saveRepos", () => {});
      const res = await req(baseUrl, "GET", "/api/repos", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe("GET /api/repos/:workDirId (single-bucket detail)", () => {
    it("returns 404 for unknown bucket", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "updateStatus", (r) => r);
      const res = await req(baseUrl, "GET", "/api/repos/nope", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 404);
    });
  });

  describe("POST /api/repos/checkout", () => {
    it("returns 401 without auth", async () => {
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {}, { repo_url: "x.git" });
      assert.equal(res.status, 401);
    });
    it("rejects missing repo_url", async () => {
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {
        "Authorization": "Bearer test-server-token",
      }, {});
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "repo_url required");
    });
    it("rejects non-.git URL", async () => {
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/no-suffix", branch: "main" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /must end in \.git/);
    });
    it("rejects invalid branch", async () => {
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git", branch: "bad branch" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /branch contains characters/);
    });
    it("returns 409 already-checked-out when bucket exists for same repo_url", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      mock.method(reposLib, "loadRepos", () => [{ work_dir_identifier: "repo", repo_url: "https://example.com/repo.git", session_state: "running" }]);
      mock.method(reposLib, "bucketIdentifier", () => "repo");
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git", branch: "main" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, "already checked out");
      assert.equal(res.body.work_dir_identifier, "repo");
    });
    it("returns 409 bucket-collision when same identifier exists with different repo_url", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      mock.method(reposLib, "loadRepos", () => [{ work_dir_identifier: "repo", repo_url: "https://OTHER.com/repo.git" }]);
      mock.method(reposLib, "bucketIdentifier", () => "repo");
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git", branch: "main" });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /bucket collision/);
      assert.equal(res.body.existing_repo_url, "https://OTHER.com/repo.git");
    });
  });

  describe("POST /api/repos/:workDirId/pause", () => {
    it("returns 404 for unknown bucket", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      const res = await req(baseUrl, "POST", "/api/repos/nope/pause", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 404);
    });
    it("returns 409 when not running", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      mock.method(reposLib, "loadRepos", () => [{ work_dir_identifier: "xyz", session_state: "paused" }]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(reposLib, "saveRepos", () => {});
      const res = await req(baseUrl, "POST", "/api/repos/xyz/pause", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
    });
    it("pauses running bucket, keeps kilo_session_id preserved", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const saved = [];
      mock.method(reposLib, "loadRepos", () => [{ work_dir_identifier: "xyz", session_state: "running", pid: 999999, kilo_session_id: "ses_keep" }]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(reposLib, "saveRepos", (r) => { saved.push(...r); });
      mock.method(reposLib, "terminateProcess", async () => {});
      const res = await req(baseUrl, "POST", "/api/repos/xyz/pause", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 200);
      assert.equal(res.body.session_state, "paused");
      assert.equal(saved[0].kilo_session_id, "ses_keep", "pause MUST preserve kilo_session_id");
      assert.equal(saved[0].pid, null);
    });
  });

  describe("POST /api/repos/:workDirId/kill", () => {
    it("returns 404 for unknown bucket", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      const res = await req(baseUrl, "POST", "/api/repos/nope/kill", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 404);
    });
    it("kills bucket + preserves work_dir + transitions to killed", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const saved = [];
      mock.method(reposLib, "loadRepos", () => [{ work_dir_identifier: "xyz", session_state: "running", pid: 999999, work_dir: "/data/repos/xyz", kilo_session_id: "ses_x" }]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(reposLib, "saveRepos", (r) => { saved.push(...r); });
      mock.method(reposLib, "terminateProcess", async () => {});
      mock.method(reposLib, "deleteCloudSession", () => ({ ok: true, reason: "deleted" }));
      const res = await req(baseUrl, "POST", "/api/repos/xyz/kill", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 200);
      assert.equal(res.body.session_state, "killed");
      assert.equal(res.body.work_dir_preserved, true);
      // Registry entry MUST still exist (kept bucket).
      assert.equal(saved.length, 1);
      assert.equal(saved[0].work_dir_identifier, "xyz");
      assert.equal(saved[0].work_dir, "/data/repos/xyz", "kill MUST preserve work_dir");
    });
  });

  describe("DELETE /api/repos/:workDirId", () => {
    it("removes work_dir + registry entry on delete", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const saved = [];
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "running", pid: 999999, work_dir: "/data/repos/xyz", kilo_session_id: "ses_x" },
        { work_dir_identifier: "abc", session_state: "stopped", work_dir: "/data/repos/abc" },
      ]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(reposLib, "saveRepos", (r) => { saved.push(...r); });
      mock.method(reposLib, "terminateProcess", async () => {});
      mock.method(reposLib, "deleteCloudSession", () => ({ ok: true }));
      mock.method(reposLib, "softDeleteWorkDir", () => ({ renamed: true, reason: "rename", trashPath: "/data/repos/.xyz.1752355200000.trash" }));
      mock.method(fs, "existsSync", () => true);
      mock.method(fs, "unlinkSync", () => {});
      const res = await req(baseUrl, "DELETE", "/api/repos/xyz", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted, true);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].work_dir_identifier, "abc", "xyz must be removed; abc remains");
    });
  });

  describe("POST /api/repos/:workDirId/continue", () => {
    it("returns 404 when bucket not found", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      const res = await req(baseUrl, "POST", "/api/repos/nope/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "test" });
      assert.equal(res.status, 404);
    });
    it("returns 409 when no kilo_session_id on bucket", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "stopped", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "test" });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /no kilo_session_id/);
    });
    it("returns 409 when session is running", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "running", kilo_session_id: "ses_x", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "test" });
      assert.equal(res.status, 409);
    });
    it("spawns kilo run for continue when stopped + has kilo_session_id", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "stopped", kilo_session_id: "ses_abc", work_dir: "/tmp/test" },
      ]);
      mock.method(reposLib, "saveRepos", () => {});
      mock.method(require(path.resolve(__dirname, "../lib/kilo.js")), "writeProjectConfig", () => {});
      mock.method(fs, "openSync", () => 999);
      mock.method(fs, "closeSync", () => {});
      const res = await req(baseUrl, "POST", "/api/repos/xyz/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "continue work" });
      assert.equal(res.status, 202);
      assert.equal(res.body.kilo_session_id, "ses_abc");
      assert.equal(res.body.prompt_excerpt, "continue work");
    });
  });

  describe("POST /api/repos/:workDirId/start (smart resume)", () => {
    it("returns 404 when bucket not found", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      const res = await req(baseUrl, "POST", "/api/repos/nope/start", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 404);
    });
    it("returns 409 already running", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "running", cloud_session_id: "ses_x", work_dir: "/tmp/test" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "updateStatus", (r) => r);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/start", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /already running/);
    });
    it("returns 409 needs_new_session when bucket has no kilo_session_id", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "paused", work_dir: "/tmp/test" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "updateStatus", (r) => r);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "saveRepos", () => {});
      mock.method(fs, "existsSync", () => true);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/start", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
      assert.equal(res.body.needs_new_session, true);
    });
    it("returns 409 needs_new_session + cloud_session_deleted when resume reports importFailed", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "paused", kilo_session_id: "ses_dead", work_dir: "/tmp/test" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "updateStatus", (r) => r);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "saveRepos", () => {});
      mock.method(fs, "existsSync", () => true);
      mock.method(require(path.resolve(__dirname, "../lib/kilo.js")), "resumeKiloSession", () =>
        Promise.resolve({ pid: 33333, started: false, importFailed: true, reason: "cloud_session_deleted" }));
      const res = await req(baseUrl, "POST", "/api/repos/xyz/start", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
      assert.equal(res.body.needs_new_session, true);
      assert.equal(res.body.cloud_session_deleted, true);
    });
    it("resumes via resumeKiloSession when cloud session is alive", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const saved = [];
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "paused", kilo_session_id: "ses_alive", work_dir: "/tmp/test" },
      ]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(reposLib, "saveRepos", (r) => { saved.push(...r); });
      mock.method(fs, "existsSync", () => true);
      mock.method(require(path.resolve(__dirname, "../lib/kilo.js")), "resumeKiloSession", () =>
        Promise.resolve({ pid: 12345, cloudSessionId: "ses_alive", started: true }));
      const res = await req(baseUrl, "POST", "/api/repos/xyz/start", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 202);
      assert.equal(res.body.kilo_session_id, "ses_alive");
      assert.equal(res.body.pid, 12345);
      assert.equal(res.body.session_state, "running");
      assert.equal(saved[0].cloud_session_status, "active");
    });
  });

  describe("POST /api/repos/:workDirId/new-session", () => {
    it("returns 404 when bucket not found", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      const res = await req(baseUrl, "POST", "/api/repos/nope/new-session", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 404);
    });
    it("starts fresh kilo session in existing work dir", async () => {
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const saved = [];
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "paused", kilo_session_id: "ses_old", work_dir: "/tmp/test" },
      ]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(reposLib, "saveRepos", (r) => { saved.push(...r); });
      mock.method(fs, "existsSync", () => true);
      mock.method(require(path.resolve(__dirname, "../lib/kilo.js")), "startKiloSession", () =>
        Promise.resolve({ pid: 55555, cloudSessionId: "ses_new", started: true }));
      const res = await req(baseUrl, "POST", "/api/repos/xyz/new-session", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 202);
      assert.equal(res.body.kilo_session_id, "ses_new");
      assert.equal(res.body.pid, 55555);
      assert.equal(res.body.session_state, "running");
      assert.equal(saved[0].cloud_session_deleted, false);
      assert.equal(saved[0].cloud_session_status, "active");
    });
  });

  describe("Auth pre-flight rejection (Q6)", () => {
    // The auth.json file is mocked as missing in beforeEach
    // (statSync throws ENOENT), so inspectAuth() returns invalid at startup.

    it("checkout returns 409 when auth invalid", async () => {
      // Force auth check to be invalid by deleting KILO_API_KEY and
      // ensuring auth.json is absent (statSync mock throws ENOENT).
      delete process.env.KILO_API_KEY;
      const res = await req(baseUrl, "POST", "/api/repos/checkout", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git", branch: "main" });
      assert.equal(res.status, 409);
      assert.equal(res.body.auth_invalid, true);
      assert.match(res.body.error, /Auth required/);
    });

    it("start returns 409 when auth invalid (no bucket)", async () => {
      delete process.env.KILO_API_KEY;
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "paused", kilo_session_id: "ses_x", work_dir: "/tmp/test" },
      ]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(fs, "existsSync", () => true);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/start", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
      assert.equal(res.body.auth_invalid, true);
    });

    it("kill returns 409 when auth invalid", async () => {
      delete process.env.KILO_API_KEY;
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const terminateSpy = mock.method(reposLib, "terminateProcess", () => Promise.resolve());
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "running", kilo_session_id: "ses_x", work_dir: "/tmp/test" },
      ]);
      mock.method(reposLib, "updateStatus", (r) => r);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/kill", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
      assert.equal(res.body.auth_invalid, true);
      assert.match(res.body.error, /Auth required/);
      // Must NOT terminate the process when auth is invalid.
      assert.equal(terminateSpy.mock.callCount(), 0);
    });

    it("new-session returns 409 when auth invalid", async () => {
      delete process.env.KILO_API_KEY;
      const reposLib = require(path.resolve(__dirname, "../lib/repos.js"));
      const startSpy = mock.method(require(path.resolve(__dirname, "../lib/kilo.js")), "startKiloSession", () =>
        Promise.resolve({ pid: 1, cloudSessionId: "ses_new", started: true }));
      mock.method(reposLib, "loadRepos", () => [
        { work_dir_identifier: "xyz", session_state: "paused", kilo_session_id: "ses_old", work_dir: "/tmp/test" },
      ]);
      mock.method(reposLib, "updateStatus", (r) => r);
      mock.method(fs, "existsSync", () => true);
      const res = await req(baseUrl, "POST", "/api/repos/xyz/new-session", { "Authorization": "Bearer test-server-token" });
      assert.equal(res.status, 409);
      assert.equal(res.body.auth_invalid, true);
      assert.equal(startSpy.mock.callCount(), 0);
    });
  });

  describe("GET /api/relay-check", () => {
    it("returns 401 without auth", async () => {
      const res = await req(baseUrl, "GET", "/api/relay-check");
      assert.equal(res.status, 401);
    });
    it("does NOT leak token in response", async () => {
      const res = await req(baseUrl, "GET", "/api/relay-check", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.auth);
      assert.equal("token" in res.body.auth, false, "must not expose token");
      assert.ok(res.body.verdict);
    });
  });

  describe("GET /api/diagnostics", () => {
    it("returns 401 without auth", async () => {
      const res = await req(baseUrl, "GET", "/api/diagnostics");
      assert.equal(res.status, 401);
    });
    it("does NOT leak token in relay field", async () => {
      const res = await req(baseUrl, "GET", "/api/diagnostics", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.relay);
      assert.equal("token" in res.body.relay, false, "must not expose token");
      assert.equal(res.body.daemon_running, false);
    });
  });

  describe("GET /api/logs", () => {
    it("requires auth", async () => {
      const res = await req(baseUrl, "GET", "/api/logs");
      assert.equal(res.status, 401);
    });
    it("returns log lines", async () => {
      const res = await req(baseUrl, "GET", "/api/logs", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.lines));
      assert.ok(typeof res.body.count === "number");
    });
  });

  describe("GET /api/logs/session/:id (relabelled: id is now work_dir_identifier)", () => {
    it("requires auth", async () => {
      const res = await req(baseUrl, "GET", "/api/logs/session/test");
      assert.equal(res.status, 401);
    });
  });

  describe("GET /api/logs/kilo-internal", () => {
    it("requires auth", async () => {
      const res = await req(baseUrl, "GET", "/api/logs/kilo-internal");
      assert.equal(res.status, 401);
    });
  });

  describe("Auth endpoints", () => {
    it("GET /api/auth/status returns idle", async () => {
      const res = await req(baseUrl, "GET", "/api/auth/status");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "idle");
    });
    it("POST /api/auth/login returns pending", async () => {
      const res = await req(baseUrl, "POST", "/api/auth/login");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "pending");
    });
    it("POST /api/auth/cancel returns cancelled", async () => {
      const res = await req(baseUrl, "POST", "/api/auth/cancel");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "cancelled");
    });
  });

  describe("X-Agent-Dock-Token auth", () => {
    it("works for gated endpoints", async () => {
      const res = await req(baseUrl, "GET", "/api/repos", {
        "X-Agent-Dock-Token": "test-server-token",
      });
      assert.equal(res.status, 200);
    });
    it("rejects wrong X-Agent-Dock-Token", async () => {
      const res = await req(baseUrl, "GET", "/api/repos", {
        "X-Agent-Dock-Token": "wrong-token",
      });
      assert.equal(res.status, 403);
    });
  });

  describe("GET /api/metrics", () => {
    it("returns live system metrics with a real CPU sample", async () => {
      const cp = require("child_process");
      let statCalls = 0;
      fs.readFileSync.mock.mockImplementation((fp, ...args) => {
        const p = String(fp);
        if (p === "/proc/stat") {
          statCalls++;
          return statCalls === 1
            ? "cpu  100 0 50 300 10 0 0 0 0 0\n"
            : "cpu  200 0 100 400 10 0 0 0 0 0\n";
        }
        if (p === "/proc/meminfo") {
          return "MemTotal: 8000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 1000000 kB\nSwapFree: 800000 kB\n";
        }
        if (p === "/proc/loadavg") return "0.50 0.60 0.70 1/100 12345\n";
        if (p === "/proc/uptime") return "12345.67 0\n";
        throw new Error("ENOENT");
      });
      // Return sensible df output just for this test.
      cp.execFileSync.mock.mockImplementation((cmd, args, opts) => {
        if (cmd === "df") return "      size      avail       used  pcent\n 1000000000   700000000   300000000    30%\n";
        return "7.3.54";
      });

      const res = await req(baseUrl, "GET", "/api/metrics", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.cpu_percent, 60);
      // No cgroup files mocked, so falls back to os.cpus().length.
      assert.equal(res.body.cpu_cores, require("os").cpus().length);
      assert.equal(res.body.load_1m, 0.5);
      assert.equal(res.body.mem_total, 8000000 * 1024);
      assert.equal(res.body.mem_available, 2000000 * 1024);
      assert.equal(res.body.mem_used, 6000000 * 1024);
      assert.equal(res.body.mem_percent, 75);
      assert.equal(res.body.swap_total, 1000000 * 1024);
      assert.equal(res.body.swap_free, 800000 * 1024);
      assert.equal(res.body.uptime_seconds, 12345.67);
      assert.equal(res.body.disk_total, 1000000000);
      assert.equal(res.body.disk_used, 300000000);
      assert.equal(res.body.disk_percent, 30);
      assert.ok(typeof res.body.timestamp === "number");
    });

    it("reports cgroup-limited cores when cpu.max is present", async () => {
      let statCalls = 0;
      fs.readFileSync.mock.mockImplementation((fp, ...args) => {
        const p = String(fp);
        if (p === "/sys/fs/cgroup/cpu.max") return "200000 100000\n";
        if (p === "/proc/stat") {
          statCalls++;
          return statCalls === 1
            ? "cpu  100 0 50 300 10 0 0 0 0 0\n"
            : "cpu  200 0 100 400 10 0 0 0 0 0\n";
        }
        if (p === "/proc/meminfo") return "MemTotal: 8000000 kB\nMemAvailable: 8000000 kB\n";
        if (p === "/proc/loadavg") return "0.50 0.60 0.70 1/100 12345\n";
        if (p === "/proc/uptime") return "12345.67 0\n";
        throw new Error("ENOENT");
      });

      const res = await req(baseUrl, "GET", "/api/metrics", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.cpu_cores, 2);
    });
  });

  describe("Removed legacy endpoints", () => {
    it("/api/spin-up returns 404", async () => {
      const res = await req(baseUrl, "POST", "/api/spin-up", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "x.git" });
      assert.equal(res.status, 404);
    });
    it("/api/sessions returns 404", async () => {
      const res = await req(baseUrl, "GET", "/api/sessions", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 404);
    });
    it("/api/kill/:id returns 404", async () => {
      const res = await req(baseUrl, "POST", "/api/kill/xyz", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 404);
    });
  });
});
