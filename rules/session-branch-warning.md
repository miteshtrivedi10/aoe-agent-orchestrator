# SESSION RULE: Warn the user that all commits stay on the checked-out branch

**This rule is active for ALL sessions. Enforce it at session start.**

## The rule
At the very start of every session — before doing any other work — warn the user (in your first message) that:

- This session is bound to the git branch that was checked out when the session started.
- **All commits created during this session will be made on that same branch.**
- The agent will not switch branches or commit to a different branch unless the user explicitly asks.

State the current branch name if it can be determined (e.g. via `git branch --show-current`), so the user knows exactly where commits will land.

## Example warning
> ⚠️ Heads up: this session is working on branch `main`. Every commit I create will be made on `main` — I won't switch branches unless you tell me to.

## Why
The session's working directory is a clone checked out at a specific branch. Commits are local to that branch, so the user should know up front where their work will be recorded before they start prompting.
