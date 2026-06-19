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
| `OPENCODE_ZEN_API_KEY` | **OpenCode Zen** — pay-as-you-go curated models |
| `OPENCODE_GO_API_KEY` | **OpenCode Go** — $10/mo subscription for open models |
| `OPENROUTER_API_KEY` | OpenRouter API key (200+ models) |
| `ANTHROPIC_API_KEY` | Anthropic/Claude API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GOOGLE_API_KEY` | Google AI Studio / Gemini API key |
| `HF_TOKEN` | Hugging Face token (for open models via HF router) |

### Slack Setup

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Choose your workspace, paste this manifest, then **Create**:

```yaml
display_information:
  name: Hermes
features:
  bot_user:
    display_name: Hermes
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  socket_mode:
    enabled: true
```

3. **Install to Workspace** → copy the **Bot Token** (`xoxb-...`)
4. **Basic Information** → **App-Level Tokens** → **Generate Token** with `connections:write` scope → copy the token (`xapp-...`)

Set these secrets:

| Secret | Description |
|--------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-...`, required for Socket Mode) |
| `SLACK_ALLOWED_USERS` | Your Slack member ID (right-click profile → **Copy member ID**) |
| `GATEWAY_ALLOW_ALL_USERS` | Set to `true` to allow any workspace user |

### Optional

| Secret | Description |
|--------|-------------|
| `MODEL` | Default model name (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `GATEWAY_ALLOW_ALL_USERS` | `true` to allow all users (use with caution) |
| `GATEWAY_ALLOWED_USERS` | Global allowlist across all platforms |

## Docs

- https://hermes-agent.nousresearch.com/docs
- https://github.com/NousResearch/hermes-agent
