# Bundled Skills & Plugins — MANDATORY usage

**Hard rule for ALL sessions. These are baked into every Kilo session to cut token cost and raise accuracy. Use them; do not bypass.**

## Auto-loaded (per session)
- `karpathy-guidelines` — skill. 4 principles: think-before-coding, simplicity-first, surgical changes, goal-driven execution.
- `caveman` — skill. Terse output; ~65% fewer output tokens.
- `context-mode` — Kilo plugin (`ctx_*` tools). Sandboxes tool output; ~98% context saved.

## Rules
1. **Karpathy first.** Before any non-trivial implement / refactor / debug task, invoke the `karpathy-guidelines` skill and follow its 4 principles: state assumptions explicitly, pick the simplest fix, touch only what the task requires, and define verifiable success criteria (tests) before looping.
2. **Caveman always on.** Reply in terse fragments — no filler, no "Sure!" / "I'd be happy to", no hedging. Keep all code, commands, file paths, and errors byte-for-byte exact. Caveman auto-reverts to full prose for security warnings and irreversible actions (e.g. `git push`, deletes) — do NOT force terse there.
3. **Route bulky output through context-mode.** For any large/structured result (logs, multi-issue fetches, file dumps, data analysis), use the `ctx_*` plugin tools (e.g. `ctx_execute`) instead of pasting raw output into context. Never dump 50 KB of raw tool output when a `ctx_*` tool returns just the answer.
4. **No bypass.** Do not disable, skip, or contradict these skills/plugins to "save time". If a `ctx_*` tool is unavailable, fall back to local execution but report the degradation.
