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
  name: Personal-Bot
features:
  bot_user:
    display_name: Personal-Bot
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
settings: {}
```

3. After creation:
   - **Settings → Socket Mode** → toggle **On** (unlocks everything)
   - **Event Subscriptions** → toggle **On** → add **bot events**:
     - `message.channels`, `message.groups`, `message.im`, `message.mpim`
   - **Interactivity** → toggle **On** (keep defaults)
4. **OAuth & Permissions** → **Install to Workspace** → copy **Bot Token** (`xoxb-...`)
5. **Basic Information** → **App-Level Tokens** → **Generate Token** with `connections:write` scope → copy token (`xapp-...`)

Socket Mode must be On before event subs or interactivity accept config without a public URL.

Set these secrets:

| Secret | Description |
|--------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-...`, required for Socket Mode) |
| `SLACK_ALLOWED_USERS` | Your Slack member ID (for initial access). Others can pair via DM |
| `GATEWAY_ALLOW_ALL_USERS` | Set to `true` to allow any workspace user (use with caution) |

### Adding other users

Once the gateway is running, anyone in your Slack workspace can DM the bot to get a **one-time pairing code**. You approve them with:

```
hermes pairing approve slack <CODE>
```

Codes expire after 1 hour. No need to collect everyone's user ID.

### Optional

| Secret | Description |
|--------|-------------|
| `MODEL` | Default model name (e.g. `openai/gpt-4o`) |
| `GATEWAY_ALLOWED_USERS` | Global allowlist across all platforms |

## Docs

- https://hermes-agent.nousresearch.com/docs
- https://github.com/NousResearch/hermes-agent
