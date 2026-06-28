---
title: AoE Agent Orchestrator
emoji: 🏛️
colorFrom: gray
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

> ⚠️ **Security note** — This Space exposes an unauthenticated HTTP API at `/api/*`, including `/api/logs`, `/api/spin-up`, `/api/sessions`, `/api/sessions/:id/continue`, and `/api/kill/:id`. Do **not** deploy publicly until rate-limiting + bearer-token auth are added, otherwise anyone with the URL can: read your logs (and the device auth code during login), clone arbitrary repos into your Space's storage, run LLM inferences against your Kilo account, and kill other users' sessions. KEEP THIS SPACE PRIVATE until hardened.

