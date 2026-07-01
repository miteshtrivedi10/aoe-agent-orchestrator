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
  for (const mod of ["/server.js", "/lib/logger.js", "/lib/auth.js", "/lib/sessions.js", "/lib/kilo.js"]) {
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
    mock.method(fs, "mkdirSync", () => {});
    const origReadFileSync = fs.readFileSync;
    mock.method(fs, "readFileSync", (fp, ...args) => {
      if (fp && fp.toString().includes("templates/index.html")) {
        return "<html><script>window.__HERMES_TOKEN__=\"\";</script></html>";
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
      HERMES_API_TOKEN: "test-server-token",
      HERMES_RATE_LIMIT: "off",
      HERMES_DEFAULT_MODEL: "kilo/kilo-auto/free",
    });

    // server.js calls app.listen(0, "0.0.0.0", cb) with PORT=0, which picks a
    // random port. We need to find that port. The app is an Express app, and
    // its listen() returns an http.Server. We can't easily get the port after
    // the fact, so we create a fresh server ourselves.
    // Instead, we extract the app from the module and create our own listener.
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
      assert.ok(res.body.includes("__HERMES_TOKEN__"));
    });
  });

  describe("GET /api/status", () => {
    it("returns version and model info", async () => {
      const res = await req(baseUrl, "GET", "/api/status");
      assert.equal(res.status, 200);
      assert.equal(res.body.kilo_version, "7.3.54");
      assert.equal(res.body.daemon_running, false);
      assert.ok(res.body.api_security.token_required);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns 401 without auth", async () => {
      const res = await req(baseUrl, "GET", "/api/sessions");
      assert.equal(res.status, 401);
    });

    it("returns sessions with valid auth", async () => {
      const res = await req(baseUrl, "GET", "/api/sessions", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe("POST /api/spin-up", () => {
    it("returns 401 without auth", async () => {
      const res = await req(baseUrl, "POST", "/api/spin-up", {}, { repo_url: "x.git" });
      assert.equal(res.status, 401);
    });

    it("rejects missing repo_url", async () => {
      const res = await req(baseUrl, "POST", "/api/spin-up", {
        "Authorization": "Bearer test-server-token",
      }, {});
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "repo_url required");
    });

    it("rejects non-.git URL", async () => {
      const res = await req(baseUrl, "POST", "/api/spin-up", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/no-suffix", branch: "main" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /must end in \.git/);
    });

    it("rejects missing branch", async () => {
      const res = await req(baseUrl, "POST", "/api/spin-up", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /branch required/);
    });

    it("rejects invalid branch", async () => {
      const res = await req(baseUrl, "POST", "/api/spin-up", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git", branch: "bad branch" });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /branch contains characters/);
    });

    it("accepts valid URL with .git and branch", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "checkoutRepo", () => ({ workDir: "/tmp/test" }));
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => []);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});
      mock.method(require(path.resolve(__dirname, "../lib/kilo.js")), "startKiloSession", () => ({
        pid: 12345, cloudSessionId: "ses_test123", ptyProcess: { write: () => {} },
      }));

      const res = await req(baseUrl, "POST", "/api/spin-up", {
        "Authorization": "Bearer test-server-token",
      }, { repo_url: "https://example.com/repo.git", branch: "main" });
      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      assert.equal(res.body.status, "running");
      assert.equal(res.body.cloud_session_id, "ses_test123");
    });
  });

  describe("POST /api/kill/:sessionId", () => {
    it("returns 404 for unknown session", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => []);
      const res = await req(baseUrl, "POST", "/api/kill/unknown", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 404);
    });

    it("kills known session", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test-kill", pid: 999999, status: "running", work_dir: "/tmp/nonexist" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});
      mock.method(fs, "unlinkSync", () => {});

      const res = await req(baseUrl, "POST", "/api/kill/test-kill", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "killed");
    });
  });

  describe("POST /api/sessions/:id/pause", () => {
    it("returns 404 for unknown", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => []);
      const res = await req(baseUrl, "POST", "/api/sessions/unknown/pause", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 404);
    });

    it("pauses running session", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test-pause", pid: 999999, status: "running" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});

      const res = await req(baseUrl, "POST", "/api/sessions/test-pause/pause", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "paused");
    });

    it("returns 409 for non-running session", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test-stopped", pid: 999999, status: "stopped" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});

      const res = await req(baseUrl, "POST", "/api/sessions/test-stopped/pause", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 409);
    });
  });

  describe("POST /api/sessions/:id/continue", () => {
    it("requires prompt in body", async () => {
      const res = await req(baseUrl, "POST", "/api/sessions/test/continue", {
        "Authorization": "Bearer test-server-token",
      }, {});
      assert.equal(res.status, 400);
    });

    it("returns 404 when session not found", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => []);
      const res = await req(baseUrl, "POST", "/api/sessions/unknown/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "test" });
      assert.equal(res.status, 404);
    });

    it("returns 409 when no cloud_session_id", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test", status: "stopped", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/sessions/test/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "test" });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /no cloud_session_id/);
    });

    it("returns 409 when session is running", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test", status: "running", cloud_session_id: "ses_xxx", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/sessions/test/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "test" });
      assert.equal(res.status, 409);
    });

    it("spawns kilo run for continue", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test-cont", status: "stopped", cloud_session_id: "ses_abc", work_dir: "/tmp/test" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});
      mock.method(fs, "openSync", () => 999);
      mock.method(fs, "closeSync", () => {});

      const res = await req(baseUrl, "POST", "/api/sessions/test-cont/continue", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "continue work" });
      assert.equal(res.status, 202);
      assert.equal(res.body.cloud_session_id, "ses_abc");
      assert.equal(res.body.prompt_excerpt, "continue work");
    });
  });

  describe("POST /api/sessions/:id/resume", () => {
    it("returns 404 when session not found", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => []);
      const res = await req(baseUrl, "POST", "/api/sessions/unknown/resume", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 404);
    });

    it("returns 409 when session is running", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test", status: "running", cloud_session_id: "ses_xxx", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/sessions/test/resume", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 409);
    });

    it("returns 409 when session is killed", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test", status: "killed", cloud_session_id: "ses_xxx", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/sessions/test/resume", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 409);
    });

    it("returns 409 when no cloud_session_id", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test", status: "paused", work_dir: "/tmp/test" },
      ]);
      const res = await req(baseUrl, "POST", "/api/sessions/test/resume", {
        "Authorization": "Bearer test-server-token",
      });
      assert.equal(res.status, 409);
    });

    it("spawns kilo run for resume", async () => {
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "test-resume", status: "paused", cloud_session_id: "ses_abc", work_dir: "/tmp/test" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});
      mock.method(fs, "openSync", () => 999);
      mock.method(fs, "closeSync", () => {});
      mock.method(fs, "existsSync", () => true);

      const res = await req(baseUrl, "POST", "/api/sessions/test-resume/resume", {
        "Authorization": "Bearer test-server-token",
      }, { prompt: "resume work" });
      assert.equal(res.status, 202);
      assert.equal(res.body.cloud_session_id, "ses_abc");
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

  describe("GET /api/logs/session/:id", () => {
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

  describe("X-Hermes-Token auth", () => {
    it("works for gated endpoints", async () => {
      const res = await req(baseUrl, "GET", "/api/sessions", {
        "X-Hermes-Token": "test-server-token",
      });
      assert.equal(res.status, 200);
    });

    it("rejects wrong X-Hermes-Token", async () => {
      const res = await req(baseUrl, "GET", "/api/sessions", {
        "X-Hermes-Token": "wrong-token",
      });
      assert.equal(res.status, 403);
    });
  });

  describe("Removed endpoints", () => {
    it("/api/logs/daemon returns 404", async () => {
      const res = await req(baseUrl, "GET", "/api/logs/daemon");
      assert.equal(res.status, 404);
    });

    it("/api/logs/remote returns 404", async () => {
      const res = await req(baseUrl, "GET", "/api/logs/remote");
      assert.equal(res.status, 404);
    });
  });
});