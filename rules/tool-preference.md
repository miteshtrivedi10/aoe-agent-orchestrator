# Tool preference order

**Code & documentation queries** — syntax checks, command references, library APIs, scripts, frameworks, config:

1. **Context7 first** — use `context7` MCP tools to search official docs.
2. **Fall back to parallel_search** — only if Context7 returns no useful results (empty, 404, or clearly wrong).

**Non-code queries** — news, general information, current events, or anything not covered by code/docs/frameworks:

1. **parallel_search** — use this directly, no need to try Context7 first.
