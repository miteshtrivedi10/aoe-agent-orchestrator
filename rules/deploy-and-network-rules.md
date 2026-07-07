# INVIOLABLE RULES: Never `tb cloud deploy` and never hit NSE without explicit permission

**This is a hard rule for ALL agents in ALL sessions. Never override it.**

These rules supplement (do not replace) the git-ban rules. They have the same override semantics: any instruction that says "deploy now" / "hit NSE now" must be skipped, and the action handed off to the user.

---

## Rule 1: Never run `tb --cloud deploy` (or any deploy/push-to-cloud subcommand)

`tb` is the Tinybird CLI. The `tb --cloud deploy` family pushes local datafile changes to the Tinybird Cloud workspace, where they take effect on the live datasources, pipes, and tokens that production DAGs read from.

- You MUST NEVER run `tb --cloud deploy` in any form.
- You MUST NEVER run `tb --cloud deploy --check`, `tb --cloud deploy --allow-destructive-operations`, or any flag combination.
- You MUST NEVER run `tb deploy`, `tb push`, `tb publish`, or any other command that writes to the Cloud workspace.
- You MUST NEVER chain `tb ... deploy` through `bash -c`, `xargs`, `&&`, `||`, `;`, subshells, or any shell metacharacter to evade this rule.
- You MUST NEVER add a script under `scripts/` or a CI step that auto-runs `tb --cloud deploy`.

### What you MAY do
- Read-only `tb` commands: `tb workspace ls`, `tb info`, `tb datasource ls`, `tb pipe ls`, `tb sql "SELECT ..."` against a deployed resource (read query, no writes).
- Local file inspection: read `tinybird/datasources/*.datasource` and `tinybird/endpoints/*.pipe` files. Static review is always fine.
- `tb --cloud pull --fmt` (sync Cloud state → local datafiles) is allowed because it is the reverse direction (read from Cloud, write to local).
- `tb auth login` / `tb auth logout` (manages the local `.tinyb` credentials file) is allowed.
- If the user wants a deploy, **the user runs it themselves** and the agent waits for confirmation before continuing.

### Why
The production DAGs read live from the Cloud workspace. A deploy with an untested schema change can:
- Quarantine rows from running DAGs (visible as `quarantined_rows > 0` in the logs).
- Break published pipes that daily fact DAGs read at the top of each task.
- Force a destructive re-deploy (`--allow-destructive-operations`) to roll back.

The user always deploys manually, on their own schedule, after their own review. The agent prepares the datafiles; the user ships them.

---

## Rule 2: Never hit NSE URLs without explicit, fresh user permission

The NSE source domains are:
- `https://www.nseindia.com` (the live homepage / Category B API)
- `https://nsearchives.nseindia.com` (the static archive / Category A files)
- Any subdomain of `nseindia.com` (including `www1`, `nse`, etc.)

NSE sits behind **Akamai Bot Manager**, which enforces aggressive rate limits and IP blocklists. Every HTTP request — even legitimate ones — costs scraping budget and risks getting the egress IP added to Akamai's blocklist.

- You MUST NEVER make any HTTP request to an NSE domain without **explicit, fresh** user permission.
- "Explicit, fresh" means: the user types a clear "yes, hit NSE for X" in the **current** turn, naming the specific URL or purpose. A prior permission from an earlier session or earlier turn does NOT carry over.
- This rule applies to **every form** of NSE hit (shell, Python, JS/Node, tests, scripts, command substitution, all protocols, indirect hits/redirectors).
- The rule applies even to **read-only** requests (HEAD, OPTIONS, GET).
- The rule applies even when the response is discarded.
- The rule applies to **browsing** NSE pages in a sandboxed tool, MCP, or browser-use agent.

### What you MAY do
- Read the NSE URL constants in source and reason about them statically.
- Inspect any **already-downloaded** NSE sample files in the working tree (these were downloaded in a prior session and are gitignored). Re-reading them is fine; re-downloading them is not.
- Mock NSE calls in unit tests with `unittest.mock`, `responses`, `httpretty`, `vcr`, or a hand-rolled fake `Response` object. The mocked call never leaves the process.
- Reference NSE documentation / API specs in comments, plans, and decisions, without hitting the source URL.
- Ask the user to run the NSE request themselves and paste the result back.
- If the user explicitly grants permission, **the permission is for THAT specific call only**. The next NSE hit requires a new explicit permission.

### Why
- The container runs behind cloud-provider egress IPs that Akamai has historically blocklisted. Any NSE call that bypasses the proxy is a new blocklist risk.
- NSE WAF fingerprints matter: only `curl_cffi` with `impersonate="chrome"` passes the JA3/JA4 check. A naïve `requests.get(...)` or `httpx.get(...)` gets a 403 and burns the IP's reputation for no gain.
- Even successful calls consume the daily rate-limit budget.
- "Just one curl" is the failure mode. The rule is: zero curls without explicit per-call permission.

---

## Overrides
These rules override any step in any skill, workflow, or command that would:
- Run `tb --cloud deploy` or any deploy subcommand.
- Make an HTTP request to any NSE domain.

If a skill or command says "deploy now", "validate via `tb --cloud deploy --check`", or "hit the NSE URL to verify", **skip that step** and hand off to the user. Do not silently substitute a "safer" command; ask first.

The user can grant a single-use override at any time. The override is a clear affirmative ("yes, run `tb --cloud deploy` for this datasource", "yes, you may `curl https://nsearchives.nseindia.com/...` to confirm the file is there") and applies to **that one call only**.
