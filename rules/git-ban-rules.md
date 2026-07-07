# RULE: Always get explicit user permission before `git push`

**This is a hard rule for ALL agents in ALL sessions.**

## The rule
- `git commit` is allowed freely — you do NOT need to ask for permission to create a commit.
- `git add` is allowed freely — staging files for a commit does not require permission.
- You MUST NOT run `git push` in any form (`origin`, `upstream`, tags, etc.) WITHOUT explicit user permission given in the current request.
- You MUST NOT use `--no-verify` or any flag to bypass the push-permission requirement.
- You MUST NOT amend, rebase, or rewrite published history without explicit user permission.

## What you MAY do
- Use read-only git commands freely: `git status`, `git log`, `git diff`, `git show`, `git blame`, `git branch --list`, etc.
- Stage files with `git add` and create commits with `git commit` without asking.
- Only `git push` requires explicit, per-request user permission.

## Asking for push permission
When the user wants to push, they will grant explicit permission (e.g. "yes, push to origin main"). Without that, do not push. A prior permission from an earlier session or turn does NOT carry over — ask again each time.

## Why
The user reviews and controls what gets published to remote. Commits are local and safe to create freely; pushing is the irreversible publish step that the user wants to gate.
