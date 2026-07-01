const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Reload the logger module fresh for each test to reset LOG_RING.
const loggerPath = path.resolve(__dirname, "../lib/logger.js");
function reloadLogger() {
  delete require.cache[require.resolve(loggerPath)];
  return require(loggerPath);
}

describe("logger", () => {
  let logger;
  let consoleLogMock;

  beforeEach(() => {
    consoleLogMock = mock.method(console, "log", () => {});
    logger = reloadLogger();
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe("logPrefix", () => {
    it("returns bracketed id", () => {
      assert.equal(logger.logPrefix("abc123"), "[abc123]");
    });
    it("returns [?] for falsy input", () => {
      assert.equal(logger.logPrefix(""), "[?]");
      assert.equal(logger.logPrefix(null), "[?]");
      assert.equal(logger.logPrefix(), "[?]");
    });
  });

  describe("log", () => {
    it("writes to LOG_RING and console.log", () => {
      logger.log("hello", "world");
      assert.equal(logger.LOG_RING.length, 1);
      assert.match(logger.LOG_RING[0], /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO \[agent-dock\] hello world/);
      assert.equal(consoleLogMock.mock.callCount(), 1);
    });

    it("trims ring when exceeding LOG_RING_MAX", () => {
      for (let i = 0; i < 600; i++) logger.log("msg", i);
      assert.ok(logger.LOG_RING.length <= logger.LOG_RING_MAX);
      assert.ok(logger.LOG_RING.length > 0);
    });

    it("handles multiple args", () => {
      logger.log("a", 1, true, { x: 1 });
      assert.equal(logger.LOG_RING.length, 1);
      assert.match(logger.LOG_RING[0], /a 1 true/);
    });
  });

  describe("stripAnsi", () => {
    it("strips SGR codes", () => {
      assert.equal(logger.stripAnsi("\x1b[31mred\x1b[0m"), "red");
    });
    it("strips CSI sequences", () => {
      assert.equal(logger.stripAnsi("\x1b[1;1Hhello"), "hello");
    });
    it("leaves plain text unchanged", () => {
      assert.equal(logger.stripAnsi("hello world"), "hello world");
    });
    it("handles empty string", () => {
      assert.equal(logger.stripAnsi(""), "");
    });
    it("strips complex TUI escape sequences", () => {
      const input = "\x1b[?2031h\x1b]10;?\x07\x1b[?25l\x1b[s\x1b[6nhello";
      const result = logger.stripAnsi(input);
      assert.equal(result, "hello", "should strip all escape sequences");
    });
  });

  describe("sanitizeLog", () => {
    it("replaces JWT tokens (eyJ... pattern)", () => {
      const input = "header.eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.signature";
      const result = logger.sanitizeLog(input);
      assert.match(result, /\[JWT\]/, "should contain [JWT] redaction");
      assert.ok(!result.includes("eyJhbGci"), "should not contain original JWT");
    });

    it("replaces Bearer tokens", () => {
      const input = "Bearer XXXX.YYYY.ZZZZ";
      assert.equal(logger.sanitizeLog(input), "Bearer [REDACTED]");
    });

    it("replaces GitHub tokens", () => {
      assert.equal(logger.sanitizeLog("ghp_abc123def456"), "[GITHUB_TOKEN]");
      assert.equal(logger.sanitizeLog("github_pat_xyz789"), "[GITHUB_TOKEN]");
    });

    it("replaces key/secret patterns", () => {
      assert.match(logger.sanitizeLog('"token" = "abc123"'), /token.*REDACTED/);
      assert.match(logger.sanitizeLog('"secret": "mysecret"'), /secret.*REDACTED/);
      assert.match(logger.sanitizeLog('"password" = "pass123"'), /password.*REDACTED/);
    });

    it("truncates to 500 chars", () => {
      const long = "x".repeat(1000);
      assert.ok(logger.sanitizeLog(long).length <= 500);
    });

    it("returns unchanged text when no secrets", () => {
      assert.equal(logger.sanitizeLog("ordinary log message"), "ordinary log message");
    });
  });

  describe("sleep", () => {
    it("resolves after given ms", async () => {
      const start = Date.now();
      await logger.sleep(50);
      assert.ok(Date.now() - start >= 40);
    });
  });

  describe("waitForString", () => {
    it("resolves true when needle found", async () => {
      let text = "";
      const promise = logger.waitForString(() => text, "test", 2, ["hello"]);
      setTimeout(() => { text = "some text hello world"; }, 100);
      const result = await promise;
      assert.equal(result, true);
    });

    it("resolves false on timeout", async () => {
      const result = await logger.waitForString(() => "nothing", "test", 0.2, ["needle"]);
      assert.equal(result, false);
    });

    it("skips already-seen portions", async () => {
      let text = "initial text";
      // Wait for needle to appear in new data only
      const promise = logger.waitForString(() => text, "test", 2, ["new"]);
      setTimeout(() => { text = "initial text"; }, 100);
      setTimeout(() => { text = "initial textnew here"; }, 300);
      const result = await promise;
      assert.equal(result, true);
    });
  });
});