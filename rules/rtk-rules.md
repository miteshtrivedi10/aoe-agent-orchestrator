# RULE: Always route shell commands through RTK

**This is a hard rule for ALL agents in ALL sessions.**

## The rule

- You MUST prefix every shell command with `rtk` when RTK supports it.
  This includes — but is not limited to — `git`, `cargo`, `npm`, `yarn`,
  `pnpm`, `pip`, `python`, `pytest`, `ruff`, `docker`, `kubectl`,
  `gh` (GitHub CLI), `aws`, `grep`, `find`, `ls`, `cat`, `head`, `tail`,
  `wc`, `sort`, `uniq`, `diff`, `sed`, `awk`, `curl`, `tar`, `gzip`,
  `ssh`, `scp`, and `kubectl`.
- You MAY run a command RAW (without `rtk`) ONLY when RTK has no filter
  for it. If `rtk <cmd>` would pass through unchanged (no compression),
  the raw form is acceptable. When in doubt, try `rtk <cmd>` first — an
  unknown command is a no-op for RTK and does not break anything.
- Commands RTK has no filter for pass through unchanged (no breakage).
  So when a command is unsupported, `rtk <cmd>` and `<cmd>` are
  equivalent — use the raw form only when you have confirmed RTK has no
  filter for that specific subcommand.

## Why

RTK filters and compresses command output before it reaches the LLM
context, saving 60-90% tokens on common operations. Routing `git status`
through RTK can shrink a 4000-token diff to ~400 tokens, leaving the
agent's context budget free for reasoning instead of noise.

## Examples

```bash
# Correct — RTK-routed
rtk git status
rtk git diff --stat
rtk cargo test
rtk npm test
rtk pytest tests/test_foo.py
rtk ruff check
rtk ls src/
rtk grep "pattern" src/
rtk find "*.rs" .
rtk docker ps
rtk gh pr list
rtk aws sts get-caller-identity

# Acceptable — RTK has no filter for these, raw is equivalent
some-internal-tool --flag value
./bin/local-script.sh
```

## Meta commands

```bash
rtk gain              # Show token savings
rtk gain --history    # Command history with savings
rtk discover          # Find missed RTK opportunities in the session
rtk proxy <cmd>       # Run raw (no filtering, for debugging only)
```

`rtk proxy <cmd>` is the escape hatch when you need the unfiltered output
for debugging. Use it sparingly — it forfeits all token savings.

## Notes

- Native Read/Grep/Glob tools bypass the shell, so for read-only file
  workflows prefer shell commands (`rtk read`, `rtk grep`, `rtk find`)
  when working in a context where RTK filtering matters.
- If a command is genuinely unsupported by RTK (no filter exists), use
  the raw command and move on — do not waste turns trying to wrap it.
