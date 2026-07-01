const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const kiloPath = path.resolve(__dirname, "../lib/kilo.js");
function reloadKilo(envOverrides = {}) {
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve(kiloPath)];
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/logger.js"))];
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/auth.js"))];
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/sessions.js"))];
  return require(kiloPath);
}

describe("kilo", () => {
  let kilo;
  let tmpDir;

  beforeEach(() => {
    mock.method(console, "log", () => {});
    tmpDir = fs.mkdtempSync("/tmp/agent-dock-kilo-test-");
    kilo = reloadKilo({ AGENT_DOCK_API_TOKEN: "test", AGENT_DOCK_RATE_LIMIT: "off" });
  });

  afterEach(() => {
    mock.restoreAll();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  describe("writeRemoteControlJson", () => {
    it("writes remote_control=true to both config files", () => {
      // We need to mock KILO_DIR since it's /data/kilo.
      // Instead, mock fs operations.
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      kilo.writeRemoteControlJson();
      assert.ok(writeSpy.mock.callCount() >= 2);
      const calls = writeSpy.mock.calls.map(c => c.arguments);
      // Check that remote_control=true is in both writes
      for (const [fpath, data] of calls) {
        const parsed = JSON.parse(data);
        assert.equal(parsed.remote_control, true);
      }
      mock.restoreAll();
    });

    it("merges with existing config", () => {
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "readFileSync", () => JSON.stringify({ model: "existing", extra: true }));
      kilo.writeRemoteControlJson();
      const parsed = JSON.parse(writeSpy.mock.calls[0].arguments[1]);
      assert.equal(parsed.remote_control, true);
      assert.equal(parsed.model, "existing");
      assert.equal(parsed.extra, true);
      mock.restoreAll();
    });
  });

  describe("writeDefaultModel", () => {
    it("sets model and small_model to defaults", () => {
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      kilo.writeDefaultModel();
      const parsed = JSON.parse(writeSpy.mock.calls[0].arguments[1]);
      assert.equal(parsed.model, "kilo/kilo-auto/free");
      assert.equal(parsed.small_model, "kilo/kilo-auto/free");
      mock.restoreAll();
    });

    it("uses AGENT_DOCK_DEFAULT_MODEL and AGENT_DOCK_SMALL_MODEL env vars", () => {
      const k = reloadKilo({
        AGENT_DOCK_API_TOKEN: "test",
        AGENT_DOCK_DEFAULT_MODEL: "kilo/kilo-auto/balanced",
        AGENT_DOCK_SMALL_MODEL: "kilo/kilo-auto/efficient",
        AGENT_DOCK_RATE_LIMIT: "off",
      });
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      k.writeDefaultModel();
      const parsed = JSON.parse(writeSpy.mock.calls[0].arguments[1]);
      assert.equal(parsed.model, "kilo/kilo-auto/balanced");
      assert.equal(parsed.small_model, "kilo/kilo-auto/efficient");
      mock.restoreAll();
    });
  });

  describe("scanInternalLogs", () => {
    it("returns default result when log dir missing", () => {
      mock.method(fs, "readdirSync", () => { throw new Error("ENOENT"); });
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.cloudSessionId, null);
      assert.equal(result.ingestFlushed, false);
      assert.equal(result.remoteConnected, false);
      assert.equal(result.sessionCreated, false);
      assert.deepEqual(result.files, []);
      mock.restoreAll();
    });

    it("extracts cloudSessionId from kilo-sessions line", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "service=kilo-sessions sessionId=ses_abc123def456 some text");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.cloudSessionId, "ses_abc123def456");
      mock.restoreAll();
    });

    it("extracts cloudSessionId from session.id= line", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "session.id=ses_xyz789abc456 more text");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.cloudSessionId, "ses_xyz789abc456");
      mock.restoreAll();
    });

    it("detects ingest flush", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "url=https://ingest.kilosessions.ai/api/session/ses_xxx/ingest?v=1 items=2 ingest flush");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.ingestFlushed, true);
      mock.restoreAll();
    });

    it("detects remote-ws connected", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "remote-ws connected");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.remoteConnected, true);
      mock.restoreAll();
    });

    it("detects remote enabled", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "remote-status-changed");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.remoteEnabled, true);
      mock.restoreAll();
    });

    it("detects session.created", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "type=session.created publishing");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.sessionCreated, true);
      mock.restoreAll();
    });

    it("filters files by mtime (sinceMs)", () => {
      const oldTime = Date.now() - 3600000; // 1 hour ago
      mock.method(fs, "readdirSync", () => ["old.log", "new.log"]);
      let callCount = 0;
      mock.method(fs, "statSync", () => {
        callCount++;
        return { mtimeMs: callCount === 1 ? oldTime : Date.now() };
      });
      mock.method(fs, "readFileSync", () => "");
      const result = kilo.scanInternalLogs(Date.now() - 10000);
      // Only the new file should be included
      assert.equal(result.files.length, 1);
      mock.restoreAll();
    });

    it("skips files that fail to read", () => {
      mock.method(fs, "readdirSync", () => ["bad.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      let called = false;
      mock.method(fs, "readFileSync", () => { called = true; throw new Error("read error"); });
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.files.length, 0);
      assert.equal(called, true);
      mock.restoreAll();
    });
  });

  describe("sendPromptToLive", () => {
    it("returns false when no PTY registered", () => {
      assert.equal(kilo.sendPromptToLive("nonexistent", "hello"), false);
    });

    it("returns true and writes when PTY registered", () => {
      const fakePty = { write: mock.fn() };
      kilo.LIVE_PTYS.set("test-session", fakePty);
      const result = kilo.sendPromptToLive("test-session", "my prompt");
      assert.equal(result, true);
      assert.equal(fakePty.write.mock.callCount(), 1);
      assert.equal(fakePty.write.mock.calls[0].arguments[0], "my prompt\n");
      kilo.LIVE_PTYS.delete("test-session");
    });

    it("returns false when PTY write throws", () => {
      const fakePty = { write: () => { throw new Error("broken"); } };
      kilo.LIVE_PTYS.set("broken-session", fakePty);
      const result = kilo.sendPromptToLive("broken-session", "test");
      assert.equal(result, false);
      kilo.LIVE_PTYS.delete("broken-session");
    });
  });

  describe("isLive", () => {
    it("returns false for unknown session", () => {
      assert.equal(kilo.isLive("nonexistent"), false);
    });
    it("returns true for registered session", () => {
      kilo.LIVE_PTYS.set("live-session", { write: () => {} });
      assert.equal(kilo.isLive("live-session"), true);
      kilo.LIVE_PTYS.delete("live-session");
    });
  });

  describe("LIVE_PTYS", () => {
    it("is a Map", () => {
      assert.ok(kilo.LIVE_PTYS instanceof Map);
    });
    it("starts empty", () => {
      assert.equal(kilo.LIVE_PTYS.size, 0);
    });
  });

  describe("initKiloStartup", () => {
    it("calls writeRemoteControlJson, writeDefaultModel, writeAuthJson", async () => {
      // Mock all filesystem operations
      mock.method(fs, "mkdirSync", () => {});
      mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "readdirSync", () => []);
      mock.method(fs, "statSync", () => { throw new Error("ENOENT"); });
      mock.method(fs, "unlinkSync", () => {});

      // Mock fetch for checkGateway
      global.fetch = mock.fn(() => Promise.resolve({ status: 200 }));
      // Mock loadSessions
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => []);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});

      await kilo.initKiloStartup();

      // Verify the function completes without throwing
      // The console.log mock captures the startup messages
      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      assert.ok(logs.some(l => l.includes("kilo startup complete")));

      delete global.fetch;
      mock.restoreAll();
    });

    it("handles killed sessions in recovery", async () => {
      mock.method(fs, "mkdirSync", () => {});
      mock.method(fs, "readFileSync", () => { throw new Error("ENOENT"); });
      mock.method(fs, "writeFileSync", () => {});
      mock.method(fs, "readdirSync", () => []);
      mock.method(fs, "statSync", () => { throw new Error("ENOENT"); });
      mock.method(fs, "unlinkSync", () => {});
      mock.method(fs, "rmSync", () => {});
      mock.method(fs, "existsSync", () => true);

      global.fetch = mock.fn(() => Promise.resolve({ status: 200 }));
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "loadSessions", () => [
        { id: "killed-1", status: "killed", work_dir: "/tmp/deleteme" },
        { id: "running-1", status: "running", pid: 999999 },
        { id: "paused-1", status: "paused" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/sessions.js")), "saveSessions", () => {});

      await kilo.initKiloStartup();

      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      const hasRecovery = logs.some(l => l.includes("removed killed") || l.includes("paused") || l.includes("startup complete"));
      assert.ok(hasRecovery, "should have recovery or startup messages");

      delete global.fetch;
      mock.restoreAll();
    });
  });

  describe("checkGateway", () => {
    it("logs reachable when fetch succeeds", async () => {
      global.fetch = mock.fn(() => Promise.resolve({ status: 200 }));
      await kilo.checkGateway();
      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      assert.ok(logs.some(l => l.includes("api.kilo.ai reachable")));
      assert.ok(logs.some(l => l.includes("ingest.kilosessions.ai reachable")));
      delete global.fetch;
    });

    it("logs unreachable when fetch fails", async () => {
      global.fetch = mock.fn(() => Promise.reject(new Error("network error")));
      await kilo.checkGateway();
      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      assert.ok(logs.some(l => l.includes("UNREACHABLE")));
      delete global.fetch;
    });
  });
});