# GitHub MCP server — PRIORITY over raw git

A **GitHub MCP server** (`github-mcp-server`) is available in every session,
authenticated with the same `GITHUB_TOKEN` used for cloning/pushing.

## Rule: prefer GitHub MCP for ALL GitHub operations

For any interaction with GitHub, **use the GitHub MCP tools FIRST, before any
shell `git` command.** Do not reach for `git` when an equivalent MCP tool exists.

Prefer these MCP tools over raw git:

| Instead of shell `git`… | Use GitHub MCP tool |
|---|---|
| `git clone` / reading a remote file | `get_file_contents` |
| `git add` + `git commit` + `git push` | `create_or_update_file` / `push_files` |
| `git checkout -b` / `git branch` (new remote branch) | `create_branch` |
| `git push` to open a change | `create_pull_request` |
| `git fork` | `fork_repository` |
| `gh issue` / `gh pr` | `create_issue`, `list_pull_requests`, `create_pull_request_review`, … |

Only fall back to `git` when the MCP tool genuinely cannot do what you need.

## What still stays local

- **Editing files and running build/test/lint** (`rtk`, `npm test`, `ruff`, …)
  must use the local working tree — the MCP server cannot execute those. Edit
  locally, build/test locally, then **publish through MCP**.
- The local clone remains the source of truth for making and verifying changes.

## Permission & branch notes

- Publishing is still gated: `github_push_files` and `github_create_pull_request`
  require permission (like `git push`). The `github_delete_*` tools are denied.
- When you push via MCP, the target branch is the one you name in the tool call
  — it is **not** necessarily the locally checked-out branch. All commits you
  publish will land on that named branch.
