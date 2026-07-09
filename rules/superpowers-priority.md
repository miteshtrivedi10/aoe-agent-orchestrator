# Always-available skills — PRIORITY for engineering work

A set of **always-available skills** is auto-discovered from `.kilo/skills/` in
every session. The skill set is downloaded at Docker build time from
`obra/superpowers` (see `Dockerfile`), so the exact inventory may change as
upstream evolves — the rule below applies to whatever skills are present.

## Rule: prefer an always-available skill before acting

When a task matches an always-available skill's description, **invoke that skill
before any response or action** — including before clarifying questions. If there
is even a small chance a skill applies, invoke it to check; stop using it only if
it proves wrong for the situation.

At minimum, for any non-trivial engineering work follow the core flow:
1. `brainstorming` — explore intent/requirements/design before implementation.
2. `writing-plans` — produce a clear implementation plan.
3. `test-driven-development` — write the failing test first, then the minimal code.
4. `verification-before-completion` — verify (build + tests) before declaring done.
5. `finishing-a-development-branch` / `requesting-code-review` — wrap up and get review.

If a skill named above is not present (e.g. upstream renamed or removed it),
invoke the closest equivalent that is present.

## Precedence (do not conflict with standing rules)

- **Your explicit / standing instructions take highest priority.** This includes
  the injected rules in this session (e.g. `git-ban-rules` — `git push` requires
  permission, `github-mcp` — prefer the GitHub MCP server for GitHub operations,
  `file-deletion-rules` — use trash not `rm`).
- Always-available skills override default system behavior where they conflict,
  but **never** override the user's standing rules above.
- Invoke skills via the skill mechanism; do not read `SKILL.md` files manually.
