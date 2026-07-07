# RTK - Rust Token Killer (Kilo Code)

**Usage**: Token-optimized CLI proxy for shell commands.

## Rule

Always prefix shell commands with `rtk` to minimize token consumption.

This applies to ALL shell commands — git, tests, lints, builds, AWS, docker/kubectl, GitHub CLI, package managers, and more — not just git. RTK filters/compresses the output before it reaches the LLM context, saving 60-90% tokens on common operations. Always use `rtk <cmd>` instead of the raw command.

Examples:

```bash
rtk git status
rtk cargo test
rtk ls src/
rtk grep "pattern" src/
rtk find "*.rs" .
rtk docker ps
rtk gh pr list
rtk aws sts get-caller-identity
rtk ruff check
rtk pytest
```

## Meta Commands

```bash
rtk gain              # Show token savings
rtk gain --history    # Command history with savings
rtk discover          # Find missed RTK opportunities
rtk proxy <cmd>       # Run raw (no filtering, for debugging)
```

## Why

RTK filters and compresses command output before it reaches the LLM context, saving 60-90% tokens on common operations. Always use `rtk <cmd>` instead of raw commands.

## Notes

- Native Read/Grep/Glob tools bypass the shell, so for those workflows prefer shell commands (`rtk read`, `rtk grep`, `rtk find`) to get RTK filtering.
- Commands RTK has no filter for pass through unchanged (no breakage).
