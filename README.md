---
title: Hermes
emoji: 🌖
colorFrom: gray
colorTo: yellow
sdk: docker
pinned: false
---

# Hermes Agent on Hugging Face Spaces

[Hermes Agent](https://hermes-agent.nousresearch.com/) by Nous Research — the self-improving AI agent with built-in learning loop, messaging gateway, and 60+ tools.

## Usage

This space runs the Hermes Gateway as a persistent background process. Connect to it via Telegram, Discord, Slack, or any supported messaging platform.

## Configuration

Set these as **HF Space Secrets** (Settings → Repository Secrets):

### Required: Pick one model provider

| Secret | Description |
|--------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (recommended, 200+ models) |
| `ANTHROPIC_API_KEY` | Anthropic/Claude API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GOOGLE_API_KEY` | Google AI Studio / Gemini API key |
| `HF_TOKEN` | Hugging Face token (for open models via HF router) |

### Recommended: Messaging platform

Pick at least one:

| Secret | Description |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated Telegram user IDs (restrict access) |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_ALLOWED_USERS` | Comma-separated Discord user IDs |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack app token |

### Optional

| Secret | Description |
|--------|-------------|
| `MODEL` | Default model name (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `GATEWAY_ALLOW_ALL_USERS` | `true` to allow all users (use with caution) |
| `GATEWAY_ALLOWED_USERS` | Global allowlist across all platforms |

## Docs

- https://hermes-agent.nousresearch.com/docs
- https://github.com/NousResearch/hermes-agent
