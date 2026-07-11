# Git & GitHub Rules

**Hard rules for ALL agents in ALL sessions.**

## 1. Branch warning (session start)

At the start of every session, tell the user which branch is checked out (`git branch --show-current`). All commits land on that branch — never switch or commit elsewhere unless explicitly asked.

## 2. Push requires permission

| Action | Permission |
|---|---|
| `git status`, `log`, `diff`, `show`, `blame`, `branch` | Free |
| `git add`, `git commit` | Free |
| `git push` (any remote, any form) | **Explicit, per-request** |
| `--no-verify`, amend, rebase, history rewrite | **Explicit** |

- Prior permission does **not** carry over — ask each time.
- Pushing is irreversible; the user gates all publishing.

## 3. Prefer GitHub MCP over raw git

A `github-mcp-server` is available (authed via `GITHUB_TOKEN`). **Always use MCP tools first:**

| Instead of… | Use MCP tool |
|---|---|
| `git clone` / remote file read | `get_file_contents` |
| `git add` + `commit` + `push` | `create_or_update_file` / `push_files` |
| `git checkout -b` | `create_branch` |
| `git push` to open a change | `create_pull_request` |
| `gh issue` / `gh pr` | `create_issue`, `list_pull_requests`, … |

Fall back to shell `git` only when MCP genuinely cannot do the job.

## 4. Local work stays local

Edit files, run build/test/lint via the local working tree. The MCP server cannot execute those. Edit locally, verify locally, **publish through MCP**.

## 5. MCP publishing is gated

`github_push_files` and `github_create_pull_request` require explicit permission (same as `git push`). `github_delete_*` tools are denied. When pushing via MCP, the target branch is the one **named in the call**, not the locally checked-out branch.
