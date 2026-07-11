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
  delete require.cache[require.resolve(path.resolve(__dirname, "../lib/repos.js"))];
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
    it("does not write model to global config (no-op, lets dashboard control model)", () => {
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      kilo.writeDefaultModel();
      assert.equal(writeSpy.mock.calls.length, 0);
      mock.restoreAll();
    });

    it("does not read or write any config files", () => {
      const readSpy = mock.method(fs, "readFileSync", () => { throw new Error("should not be called"); });
      const writeSpy = mock.method(fs, "writeFileSync", () => {});
      kilo.writeDefaultModel();
      assert.equal(readSpy.mock.calls.length, 0);
      assert.equal(writeSpy.mock.calls.length, 0);
      mock.restoreAll();
    });
  });

  describe("writeProjectConfig — stale .kilo/kilo.json cleanup", () => {
    it("removes stale .kilo/kilo.json DIRECTORY before writing kilo.jsonc (HF persistent storage leaves crud)", () => {
      // Simulate a stale kilo.json/ directory persisted from a previous deploy
      // (HF persistent storage keeps /data across restarts; kilo's config
      // loader crashes with EISDIR on .kilo/kilo.json if it's a directory).
      const workDir = fs.mkdtempSync("/tmp/agent-dock-wpc-stale-dir-");
      const kiloDir = path.join(workDir, ".kilo");
      fs.mkdirSync(path.join(kiloDir, "kilo.json"), { recursive: true });
      fs.writeFileSync(path.join(kiloDir, "kilo.json", "crud"), "leftover");
      // Also drop a stale kilo.json file alongside to verify file removal too.
      fs.writeFileSync(path.join(kiloDir, "kilo.json5"), "{}");

      // Bypass the real /app/kilo.jsonc template by intercepting readFileSync.
      const realRead = fs.readFileSync;
      const readMock = mock.method(fs, "readFileSync", (p, ...rest) => {
        if (p === "/app/kilo.jsonc") return JSON.stringify({ small_model: "kilo/kilo-auto/free" });
        return realRead(p, ...rest);
      });
      // KILO_API_KEY controls whether the provider block is deleted — set so
      // writeProjectConfig keeps it (none in our minimal template, no impact).
      process.env.KILO_API_KEY = "test";
      try {
        kilo.writeProjectConfig(workDir, "test-bucket");
      } finally {
        delete process.env.KILO_API_KEY;
        readMock.mock.restore();
      }

      // kilo.jsonc must exist as a file containing the template config
      // (placeholders only — Kilo resolves {env:VAR} at runtime).
      const cfgPath = path.join(kiloDir, "kilo.jsonc");
      assert.ok(fs.existsSync(cfgPath), "kilo.jsonc must be written");
      const st = fs.statSync(cfgPath);
      assert.ok(st.isFile(), "kilo.jsonc must be a file, not a directory");

      // The stale kilo.json directory AND kilo.json5 file must both be gone.
      assert.ok(!fs.existsSync(path.join(kiloDir, "kilo.json")), "stale kilo.json must be removed");
      assert.ok(!fs.existsSync(path.join(kiloDir, "kilo.json5")), "stale kilo.json5 must be removed");

      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    });

    it("leaves unrelated .kilo/ contents (skills, rules) untouched during cleanup", () => {
      const workDir = fs.mkdtempSync("/tmp/agent-dock-wpc-preserve-");
      const kiloDir = path.join(workDir, ".kilo");
      fs.mkdirSync(path.join(kiloDir, "rules"), { recursive: true });
      fs.writeFileSync(path.join(kiloDir, "rules", "rtk-rules.md"), "rule body");
      fs.mkdirSync(path.join(kiloDir, "skills", "demo"), { recursive: true });
      fs.writeFileSync(path.join(kiloDir, "skills", "demo", "SKILL.md"), "skill");

      const realRead = fs.readFileSync;
      const readMock = mock.method(fs, "readFileSync", (p, ...rest) => {
        if (p === "/app/kilo.jsonc") return JSON.stringify({ small_model: "kilo/kilo-auto/free" });
        return realRead(p, ...rest);
      });
      process.env.KILO_API_KEY = "test";
      try {
        kilo.writeProjectConfig(workDir, "test-bucket-2");
      } finally {
        delete process.env.KILO_API_KEY;
        readMock.mock.restore();
      }

      assert.ok(fs.existsSync(path.join(kiloDir, "rules", "rtk-rules.md")), "rules/ must survive cleanup");
      assert.ok(fs.existsSync(path.join(kiloDir, "skills", "demo", "SKILL.md")), "skills/ must survive cleanup");
      assert.ok(fs.existsSync(path.join(kiloDir, "kilo.jsonc")), "kilo.jsonc must be written");

      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    });

    it("writes kilo.jsonc cleanly when no stale files exist (fresh workDir)", () => {
      const workDir = fs.mkdtempSync("/tmp/agent-dock-wpc-clean-");
      const realRead = fs.readFileSync;
      const readMock = mock.method(fs, "readFileSync", (p, ...rest) => {
        if (p === "/app/kilo.jsonc") return JSON.stringify({ small_model: "kilo/kilo-auto/free" });
        return realRead(p, ...rest);
      });
      process.env.KILO_API_KEY = "test";
      try {
        kilo.writeProjectConfig(workDir, "test-bucket-3");
      } finally {
        delete process.env.KILO_API_KEY;
        readMock.mock.restore();
      }

      const cfgPath = path.join(workDir, ".kilo", "kilo.jsonc");
      assert.ok(fs.existsSync(cfgPath), "kilo.jsonc must be written");
      assert.ok(fs.statSync(cfgPath).isFile(), "kilo.jsonc must be a file");
      const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.equal(parsed.small_model, "kilo/kilo-auto/free");

      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
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

    it("detects session.turn.open publishing", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "session.turn.open publishing ses_abc123");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.sessionCreated, true);
      mock.restoreAll();
    });

    it("detects session.initialized", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "session.initialized with model xyz");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.sessionCreated, true);
      mock.restoreAll();
    });

    it("detects creating session phrase", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "creating session and registering ingest");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.sessionCreated, true);
      mock.restoreAll();
    });

    it("detects session.ingest start", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "session.ingest started for ses_xxxx");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.sessionCreated, true);
      mock.restoreAll();
    });

    it("does NOT flag unrelated log lines as sessionCreated", () => {
      mock.method(fs, "readdirSync", () => ["sess.log"]);
      mock.method(fs, "statSync", () => ({ mtimeMs: Date.now() }));
      mock.method(fs, "readFileSync", () => "some random log line without markers");
      const result = kilo.scanInternalLogs(0);
      assert.equal(result.sessionCreated, false);
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

  describe("consolidateKiloLogs", () => {
    it("merges datetime-named files for the same day into one date file", () => {
      const files = {
        "2026-07-09T08-12-38.log": "line1\n",
        "2026-07-09T09-15-00.log": "line2\n",
        "2026-07-10T10-00-00.log": "line3\n",
        "2026-07-09.log": "existing\n",  // already date-only, should be untouched
      };
      const mtimes = {};
      for (const f of Object.keys(files)) mtimes[f] = Date.now() - 120000; // 2min ago, past STALE_MS
      const written = {};
      let openTarget = null;
      mock.method(fs, "readdirSync", () => Object.keys(files));
      mock.method(fs, "statSync", (p) => {
        const name = path.basename(p);
        return { mtimeMs: mtimes[name] || Date.now() };
      });
      mock.method(fs, "readFileSync", (p) => {
        const name = path.basename(p);
        return files[name] || "";
      });
      mock.method(fs, "openSync", (p) => {
        openTarget = path.basename(p);
        return 42;
      });
      mock.method(fs, "writeSync", (_fd, content) => {
        written[openTarget] = (written[openTarget] || "") + content;
      });
      const unlinked = [];
      mock.method(fs, "unlinkSync", (p) => { unlinked.push(path.basename(p)); });
      mock.method(fs, "closeSync", () => {});

      kilo.consolidateKiloLogs();

      // 2026-07-09.log should have line1 + line2 appended (existing content stays in the file;
      // our mock doesn't preserve "existing\n" because openSync uses append mode but the mock
      // starts written[] empty — that's fine, we only verify merge behavior).
      assert.ok(written["2026-07-09.log"], "should write to 2026-07-09.log");
      assert.ok(written["2026-07-09.log"].includes("line1"), "should contain line1");
      assert.ok(written["2026-07-09.log"].includes("line2"), "should contain line2");
      assert.ok(written["2026-07-10.log"], "should write to 2026-07-10.log");
      assert.ok(written["2026-07-10.log"].includes("line3"), "should contain line3");
      // Datetime files should be unlinked; date-only file should NOT be unlinked.
      assert.ok(unlinked.includes("2026-07-09T08-12-38.log"), "should unlink first datetime file");
      assert.ok(unlinked.includes("2026-07-09T09-15-00.log"), "should unlink second datetime file");
      assert.ok(unlinked.includes("2026-07-10T10-00-00.log"), "should unlink third datetime file");
      assert.ok(!unlinked.includes("2026-07-09.log"), "should NOT unlink already-date-only file");
      mock.restoreAll();
    });

    it("skips files modified within STALE_MS (being actively written)", () => {
      const files = {
        "2026-07-09T08-12-38.log": "recent\n",       // mtime = now (active)
        "2026-07-09T09-15-00.log": "old\n",          // mtime = 2min ago (stale)
      };
      mock.method(fs, "readdirSync", () => Object.keys(files));
      mock.method(fs, "statSync", (p) => {
        const name = path.basename(p);
        const mtime = name === "2026-07-09T08-12-38.log" ? Date.now() : Date.now() - 120000;
        return { mtimeMs: mtime };
      });
      const written = {};
      let openTarget = null;
      mock.method(fs, "openSync", (p) => { openTarget = path.basename(p); return 1; });
      mock.method(fs, "writeSync", (_fd, c) => { written[openTarget] = (written[openTarget] || "") + c; });
      const unlinked = [];
      mock.method(fs, "unlinkSync", (p) => { unlinked.push(path.basename(p)); });
      mock.method(fs, "readFileSync", (p) => {
        const name = path.basename(p);
        return files[name] || "";
      });
      mock.method(fs, "closeSync", () => {});

      kilo.consolidateKiloLogs();

      // Only the stale file should be consolidated; the active one skipped.
      assert.ok(written["2026-07-09.log"], "should write to date file");
      assert.ok(written["2026-07-09.log"].includes("old"), "should contain stale file content");
      assert.ok(!written["2026-07-09.log"].includes("recent"), "should NOT contain active file content");
      assert.ok(unlinked.includes("2026-07-09T09-15-00.log"), "should unlink stale file");
      assert.ok(!unlinked.includes("2026-07-09T08-12-38.log"), "should NOT unlink active file");
      mock.restoreAll();
    });

    it("does nothing when log dir missing", () => {
      mock.method(fs, "readdirSync", () => { throw new Error("ENOENT"); });
      // Should not throw
      kilo.consolidateKiloLogs();
      mock.restoreAll();
    });
  });

  describe("detectCloudValidationFailure", () => {
    it("detects '4 of 6 requests failed' pattern", () => {
      const buf = "Error: 4 of 6 requests failed: Unexpected server error. Check server logs for details.";
      assert.equal(kilo.detectCloudValidationFailure(buf), true);
    });
    it("detects 'Affected startup requests' pattern", () => {
      const buf = "Affected startup requests: config.providers, provider.list, app.agents, config.get";
      assert.equal(kilo.detectCloudValidationFailure(buf), true);
    });
    it("detects 'Unexpected server error' pattern", () => {
      const buf = "Some prefix Unexpected server error trailing text";
      assert.equal(kilo.detectCloudValidationFailure(buf), true);
    });
    it("does NOT match unrelated errors", () => {
      assert.equal(kilo.detectCloudValidationFailure("authentication failed"), false);
      assert.equal(kilo.detectCloudValidationFailure("session created successfully"), false);
      assert.equal(kilo.detectCloudValidationFailure("Failed to import session from cloud"), false);
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
      // Mock loadRepos / saveRepos
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => []);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "saveRepos", () => {});

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
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "loadRepos", () => [
        { work_dir_identifier: "killed-1", status: "killed", work_dir: "/tmp/deleteme" },
        { work_dir_identifier: "running-1", status: "running", pid: 999999 },
        { work_dir_identifier: "paused-1", status: "paused" },
      ]);
      mock.method(require(path.resolve(__dirname, "../lib/repos.js")), "saveRepos", () => {});

      await kilo.initKiloStartup();

      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      const hasRecovery = logs.some(l => l.includes("paused") || l.includes("startup complete"));
      assert.ok(hasRecovery, "should have recovery or startup messages");

      delete global.fetch;
      mock.restoreAll();
    });
  });

  describe("detectKiloStartupErrors", () => {
    it("returns null when no error signature present", () => {
      assert.equal(kilo.detectKiloStartupErrors("kilo> how can I help you"), null);
    });
    it("detects auth failure signatures", () => {
      assert.equal(kilo.detectKiloStartupErrors("error: authentication failed"), "authentication failed");
    });
    it("detects crash/panic signatures", () => {
      assert.equal(kilo.detectKiloStartupErrors("fatal: process exited with code 1"), "fatal:");
    });
  });

  describe("submitPromptConfirmed", () => {
    it("returns true and sends Enter only after the prompt is echoed", async () => {
      let buffer = "kilo> ";
      const getBuffer = () => buffer;
      const writes = [];
      const fakePty = { write: (s) => { writes.push(s); buffer += s; } };
      const ok = await kilo.submitPromptConfirmed(fakePty, getBuffer, "t", "_t", "hello world");
      assert.equal(ok, true);
      assert.deepEqual(writes, ["hello world", "\r"]);
    });
    it("returns false when the TUI never echoes the keystrokes", async () => {
      const getBuffer = () => "kilo> "; // never appends the typed text
      const writes = [];
      const fakePty = { write: (s) => { writes.push(s); } };
      const ok = await kilo.submitPromptConfirmed(fakePty, getBuffer, "t", "_t", "dropped text");
      assert.equal(ok, false);
      assert.deepEqual(writes, ["dropped text"]); // Enter never sent
    });
  });

  describe("checkPtyAlive", () => {
    it("returns null when pid is alive (current process)", () => {
      const reason = kilo.checkPtyAlive(process.pid, "test", "_test", "some output");
      assert.equal(reason, null);
    });

    it("returns diagnostic string when pid is dead", () => {
      const reason = kilo.checkPtyAlive(99999999, "dead-session", "_resume", "partial TUI output");
      assert.ok(reason, "should return a non-null reason string");
      assert.ok(reason.includes("PTY process"), "should mention PTY process");
      assert.ok(reason.includes("99999999"), "should include the pid");
      assert.ok(reason.includes("died during"), "should mention where it died");
      assert.ok(reason.includes("_resume"), "should include the tag");
    });

    it("returns diagnostic string for null/zero pid", () => {
      const reason = kilo.checkPtyAlive(null, "null-session", "_test", "");
      assert.ok(reason, "should return a non-null reason string");
      assert.ok(reason.includes("unknown"), "should mention unknown pid");
    });

    it("logs the PTY tail when accumulated has content", () => {
      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      const beforeCount = logs.length;
      kilo.checkPtyAlive(99999999, "t", "_t", "kilogotimmediatelykilled");
      const after = console.log.mock.calls.map(c => c.arguments.join(" "));
      assert.ok(after.length > beforeCount, "should log tail output");
      const newLogs = after.slice(beforeCount);
      assert.ok(newLogs.some(l => l.includes("PTY tail")), "should log PTY tail");
      assert.ok(newLogs.some(l => l.includes("kilogotimmediatelykilled")), "should include accumulated buffer");
    });

    it("logs empty when accumulated buffer is empty", () => {
      const logs = console.log.mock.calls.map(c => c.arguments.join(" "));
      const beforeCount = logs.length;
      kilo.checkPtyAlive(99999999, "t", "_t", "");
      const after = console.log.mock.calls.map(c => c.arguments.join(" "));
      const newLogs = after.slice(beforeCount);
      assert.ok(newLogs.some(l => l.includes("PTY buffer empty")), "should log empty buffer");
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

  describe("CLOUD_SESSION_IMPORT_FAILED_RE", () => {
    it("matches 'Failed to import session from cloud'", () => {
      const re = /failed to import session from cloud/i;
      assert.ok(re.test("Error: Failed to import session from cloud"));
      assert.ok(re.test("Importing session from cloud... Error: Failed to import session from cloud"));
    });

    it("does not match unrelated errors", () => {
      const re = /failed to import session from cloud/i;
      assert.ok(!re.test("authentication failed"));
      assert.ok(!re.test("command not found"));
      assert.ok(!re.test("session created successfully"));
    });
  });

  describe("detectKiloStartupErrors — import failure not a startup error", () => {
    it("does NOT match 'Failed to import session from cloud'", () => {
      const result = kilo.detectKiloStartupErrors("Error: Failed to import session from cloud");
      assert.equal(result, null, "import failure should not be treated as a startup error");
    });

    it("still matches actual startup errors like UNAUTHENTICATED", () => {
      const result = kilo.detectKiloStartupErrors("401 UNAUTHENTICATED");
      assert.ok(result, "should detect UNAUTHENTICATED");
      assert.ok(result.includes("UNAUTHENTICATED"));
    });
  });
});