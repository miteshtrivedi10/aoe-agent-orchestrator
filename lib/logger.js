const LOG_RING = [];
const LOG_RING_MAX = 500;

function log(...args) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `${ts} INFO [agent-dock] ${args.join(" ")}`;
  LOG_RING.push(msg);
  if (LOG_RING.length > LOG_RING_MAX) LOG_RING.splice(0, 100);
  console.log(msg);
}

function logPrefix(sid) {
  return `[${sid || "?"}]`;
}

function stripAnsi(text) {
  return text.replace(
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b[>=]|\x1b\[\?[0-9;]*[a-zA-Z]|\x1b[NOc78DMEHABCDGJKLMPRSTZ]|\x1b\[[0-9;]*[HfJKMmr]|\x1b[()][AB012]/g,
    ""
  );
}

function sanitizeLog(text) {
  return text
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[JWT]")
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-]+(\.[a-zA-Z0-9_\-]+)+/gi, "$1[REDACTED]")
    .replace(/(gh[pousr]_|github_pat_)[a-zA-Z0-9]+/g, "[GITHUB_TOKEN]")
    .replace(/(["':])(token|key|secret|password|access_token|refresh_token)(["':])\s*[:=]\s*["']?[a-zA-Z0-9_\-\.\/+]+/gi, "$1$2$3=[REDACTED]")
    .slice(0, 500);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForString(getText, label, timeoutSec, needles) {
  return new Promise((resolve) => {
    const start = Date.now();
    let seenLen = 0;
    const check = () => {
      const text = getText();
      if (text.length > seenLen) {
        const newData = text.slice(seenLen);
        const matched = needles.filter((n) => newData.includes(n));
        if (matched.length > 0) {
          log(`_wait ${logPrefix(label)} detected after ${((Date.now() - start) / 1000).toFixed(1)}s matched=${JSON.stringify(matched)}`);
          resolve(true);
          return;
        }
        seenLen = text.length;
      }
      if (Date.now() - start > timeoutSec * 1000) {
        log(`_wait ${logPrefix(label)} timeout after ${timeoutSec}s`);
        resolve(false);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

module.exports = { LOG_RING, LOG_RING_MAX, log, logPrefix, stripAnsi, sanitizeLog, sleep, waitForString };