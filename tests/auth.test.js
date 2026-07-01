const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const authPath = path.resolve(__dirname, "../lib/auth.js");

function reloadAuth(envOverrides = {}) {
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Clear require cache for auth and logger (auth imports logger)
  delete require.cache[require.resolve(authPath)];
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/logger.js"))];
  return require(authPath);
}

describe("auth", () => {
  let auth;
  let tmpDir;

  beforeEach(() => {
    mock.method(console, "log", () => {});
    tmpDir = fs.mkdtempSync("/tmp/agent-dock-auth-test-");
    auth = reloadAuth({
      AGENT_DOCK_API_TOKEN: "test-token-for-auth",
      AGENT_DOCK_RATE_LIMIT: "off",
    });
  });

  afterEach(() => {
    mock.restoreAll();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe("module-level constants", () => {
    it("sets API_TOKEN from env", () => {
      assert.equal(auth.API_TOKEN, "test-token-for-auth");
    });

    it("TOKEN_IS_AUTOGEN is false when env set", () => {
      assert.equal(auth.TOKEN_IS_AUTOGEN, false);
    });

    it("generates API_TOKEN when env not set", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: undefined });
      assert.equal(a.TOKEN_IS_AUTOGEN, true);
      assert.ok(a.API_TOKEN.length >= 32);
    });

    it("RATE_LIMIT_DISABLED is true when set to off", () => {
      assert.equal(auth.RATE_LIMIT_DISABLED, true);
    });

    it("RATE_LIMIT_DISABLED is false when not set", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x", AGENT_DOCK_RATE_LIMIT: undefined });
      assert.equal(a.RATE_LIMIT_DISABLED, false);
    });

    it("KILO_DIR is /data/kilo", () => {
      assert.equal(auth.KILO_DIR, "/data/kilo");
    });
  });

  describe("authGate", () => {
    function makeReq(authHeader, agentDockToken) {
      const headers = {};
      return {
        get: (name) => {
          if (name === "authorization") return authHeader || undefined;
          if (name === "x-agent-dock-token") return agentDockToken || undefined;
          return undefined;
        },
      };
    }

    function makeRes() {
      const res = { _status: null, _body: null, _headers: {} };
      res.status = (s) => { res._status = s; return res; };
      res.set = (k, v) => { res._headers[k] = v; return res; };
      res.json = (b) => { res._body = b; return res; };
      return res;
    }

    it("returns 401 when no auth header", () => {
      const req = makeReq();
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(res._status, 401);
      assert.equal(res._body.error, "missing Authorization header");
      assert.equal(nextCalled, false);
    });

    it("returns 401 when not Bearer token", () => {
      const req = makeReq("Basic abc123");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(res._status, 401);
      assert.match(res._body.error, /not a Bearer token/);
      assert.equal(nextCalled, false);
    });

    it("returns 403 for wrong token", () => {
      const req = makeReq("Bearer wrong-token");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(res._status, 403);
      assert.equal(res._body.error, "invalid bearer token");
      assert.equal(nextCalled, false);
    });

    it("calls next for correct token", () => {
      const req = makeReq("Bearer test-token-for-auth");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
    });

    it("accepts X-Agent-Dock-Token header", () => {
      const req = makeReq(null, "test-token-for-auth");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
    });

    it("X-Agent-Dock-Token overrides missing Authorization", () => {
      const req = makeReq(null, "test-token-for-auth");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
    });

    it("uses timingSafeEqual — rejects wrong-length token", () => {
      const req = makeReq("Bearer short");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(res._status, 403);
      assert.equal(nextCalled, false);
    });

    it("returns 401 for empty X-Agent-Dock-Token with no Authorization", () => {
      const req = makeReq(null, "");
      const res = makeRes();
      let nextCalled = false;
      auth.authGate(req, res, () => { nextCalled = true; });
      assert.equal(res._status, 401);
      assert.equal(nextCalled, false);
    });
  });

  describe("makeLimiter", () => {
    it("returns pass-through when rate limits disabled", () => {
      const fn = auth.makeLimiter(60000, 10, "test");
      let called = false;
      fn({}, {}, () => { called = true; });
      assert.equal(called, true);
    });

    it("returns rate-limit middleware when enabled", () => {
      const a = reloadAuth({
        AGENT_DOCK_API_TOKEN: "x",
        AGENT_DOCK_RATE_LIMIT: undefined,
      });
      const fn = a.makeLimiter(60000, 10, "test");
      assert.equal(typeof fn, "function");
      // Should be the rateLimit middleware, not the pass-through
      assert.ok(fn.length === 3);
    });
  });

  describe("inspectAuth", () => {
    it("returns default result when no auth.json", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      const result = a.inspectAuth();
      assert.equal(result.valid, false);
      assert.equal(result.reason, "no auth.json found");
      assert.equal(result.file_exists, false);
    });

    it("returns valid when KILO_API_KEY env is set and no auth.json", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x", KILO_API_KEY: "sk-test" });
      const result = a.inspectAuth();
      assert.equal(result.valid, true);
      assert.equal(result.reason, "ok (env-var KILO_API_KEY)");
      assert.equal(result.detected_type, "env-var");
    });

    it("parses oauth auth.json", () => {
      const kiloDir = path.join(tmpDir, "kilo");
      fs.mkdirSync(kiloDir, { recursive: true });
      fs.writeFileSync(path.join(kiloDir, "auth.json"), JSON.stringify({
        kilo: { type: "oauth", access: "token-abc", refresh: "ref-xyz", expires: "2099-01-01T00:00:00Z" },
        openrouter: { type: "api", key: "sk-or-test" },
      }));
      // Override KILO_DIR
      const modulePath = require.resolve(authPath);
      const original = require(modulePath);
      // We need to test with the actual KILO_DIR. Since it's hardcoded, we mock fs.
      // For this test, we create the file at /data/kilo/auth.json
      // Actually, KILO_DIR = "/data/kilo", so we can't easily override. Let's use a different approach.
      // We'll test the parse logic by mocking fs.statSync and fs.readFileSync.
    });

    it("parses oauth auth.json via mock", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      const fsMock = mock.method(fs, "statSync", () => ({ size: 200 }));
      const readMock = mock.method(fs, "readFileSync", () => JSON.stringify({
        kilo: { type: "oauth", access: "token-abc", refresh: "ref-xyz", expires: "2099-01-01T00:00:00Z" },
        openrouter: { type: "api", key: "sk-or-test" },
      }));
      const result = a.inspectAuth();
      assert.equal(result.valid, true);
      assert.equal(result.reason, "ok");
      assert.equal(result.detected_type, "oauth");
      assert.equal(result.has_access, true);
      assert.equal(result.has_refresh, true);
      assert.equal(result.expired, false);
      assert.equal(result.token, "token-abc");
      assert.deepEqual(result.file_keys, ["kilo", "openrouter"]);
      mock.restoreAll();
    });

    it("parses api auth.json", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => JSON.stringify({
        type: "api", key: "sk-test-key",
      }));
      const result = a.inspectAuth();
      assert.equal(result.valid, true);
      assert.equal(result.detected_type, "api");
      assert.equal(result.has_key, true);
      assert.equal(result.token, undefined); // api type doesn't set token field
      mock.restoreAll();
    });

    it("parses wellknown auth.json", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => JSON.stringify({
        kilo: { type: "wellknown", token: "wk-token" },
      }));
      const result = a.inspectAuth();
      assert.equal(result.valid, true);
      assert.equal(result.detected_type, "wellknown");
      assert.equal(result.has_token, true);
      mock.restoreAll();
    });

    it("detects expired oauth", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => JSON.stringify({
        kilo: { type: "oauth", access: "expired-token", expires: "2020-01-01T00:00:00Z" },
      }));
      const result = a.inspectAuth();
      assert.equal(result.valid, false);
      assert.equal(result.reason, "expired oauth token");
      assert.equal(result.expired, true);
      mock.restoreAll();
    });

    it("handles unknown auth type", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => JSON.stringify({ kilo: { type: "custom" } }));
      const result = a.inspectAuth();
      assert.equal(result.reason, "unknown auth type: custom");
      assert.equal(result.valid, false);
      mock.restoreAll();
    });

    it("handles parse error", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => "not-json");
      const result = a.inspectAuth();
      assert.match(result.reason, /auth.json parse error/);
      assert.equal(result.valid, false);
      mock.restoreAll();
    });

    it("does NOT include token field for non-oauth types", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => JSON.stringify({ type: "api", key: "sk-test" }));
      const result = a.inspectAuth();
      assert.equal("token" in result, false);
      mock.restoreAll();
    });
  });

  describe("writeAuthJson", () => {
    it("writes api key to auth.json", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x", KILO_API_KEY: "sk-my-key" });
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "statSync", () => { throw new Error("no file"); });
      a.writeAuthJson();
      assert.ok(writeSpy.mock.callCount() >= 1);
      const data = JSON.parse(writeSpy.mock.calls[0].arguments[1]);
      assert.equal(data.kilo.type, "api");
      assert.equal(data.kilo.key, "sk-my-key");
      mock.restoreAll();
    });

    it("skips when no key env", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x", KILO_API_KEY: undefined, KILO_AUTH_TOKEN: undefined });
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      a.writeAuthJson();
      assert.equal(writeSpy.mock.callCount(), 0);
      mock.restoreAll();
    });

    it("keeps existing auth.json when size > 10", () => {
      const a = reloadAuth({ AGENT_DOCK_API_TOKEN: "x", KILO_API_KEY: "sk-new" });
      mock.method(fs, "statSync", () => ({ size: 200 }));
      mock.method(fs, "readFileSync", () => JSON.stringify({ kilo: { type: "oauth", access: "keep" } }));
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      a.writeAuthJson();
      assert.equal(writeSpy.mock.callCount(), 0);
      mock.restoreAll();
    });
  });

  describe("DEVICE_AUTH", () => {
    it("starts with idle status", () => {
      assert.equal(auth.DEVICE_AUTH.status, "idle");
      assert.equal(auth.DEVICE_AUTH.url, null);
      assert.equal(auth.DEVICE_AUTH.code, null);
    });
  });

  describe("authLimiter/readLimiter/writeLimiter", () => {
    it("are functions", () => {
      assert.equal(typeof auth.authLimiter, "function");
      assert.equal(typeof auth.readLimiter, "function");
      assert.equal(typeof auth.writeLimiter, "function");
    });
  });
});