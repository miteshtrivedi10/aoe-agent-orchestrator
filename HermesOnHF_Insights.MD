---
title: Hermes
emoji: 🌖
colorFrom: gray
colorTo: yellow
sdk: docker
pinned: false
---

# Hermes Agent on Hugging Face Spaces

[Hermes Agent](https://hermes-agent.nousresearch.com/) by Nous Research — self-improving AI agent with messaging gateway, learning loop, and 60+ tools.

This Space runs the **Hermes Gateway** as a persistent background process. Connect via Slack, Telegram, Discord, or any supported platform.

---

## Prerequisites

- [Hugging Face](https://huggingface.co) account
- A Slack workspace where you can install apps
- An LLM provider API key

---

## Step 1: Create the HF Space

1. Go to https://huggingface.co/new-space
2. **Space Name:** `hermes` (or your choice)
3. **License:** MIT
4. **Space SDK:** Docker
5. **Visibility:** Private (recommended)
6. **Space Hardware:** CPU (free tier works; upgrade if needed)
7. Click **Create Space**

---

## Step 2: Add files

Push these three files to your Space's `main` branch.

### `Dockerfile`

```dockerfile
FROM python:3.11-slim

LABEL org.opencontainers.image.source="https://github.com/NousResearch/hermes-agent"
LABEL org.opencontainers.image.description="Hermes Agent — the self-improving AI agent by Nous Research"

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# System deps: git + browser tooling
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ripgrep \
    ffmpeg \
    xz-utils && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /var/cache/apt/*

# Install Hermes Agent with messaging extras
RUN pip install --no-cache-dir --break-system-packages "hermes-agent[all,messaging]"

ENV HERMES_HOME="/root/.hermes"
WORKDIR /root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/entrypoint.sh"]
```

### `entrypoint.sh`

```bash
#!/bin/bash
set -e

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"

# Write relevant env vars to .env so hermes gateway picks them up
ENV_FILE="$HERMES_HOME/.env"
> "$ENV_FILE"

for var in $(compgen -e); do
  case "$var" in
    HERMES_*|HF_*|OPENAI_*|OPENROUTER_*|ANTHROPIC_*|DEEPSEEK_*|\
    GOOGLE_*|GEMINI_*|GITHUB_*|SLACK_*|GATEWAY_*|\
    OPENCODE_*|TELEGRAM_*|DISCORD_*|MODEL|LM_*|OLLAMA_*)
      val="${!var}"
      if [ -n "$val" ]; then
        echo "$var=$val" >> "$ENV_FILE"
      fi
      ;;
  esac
done

echo "[entrypoint] Wrote $(wc -l < "$ENV_FILE") vars"

# Write model to config.yaml
MODEL="${MODEL:-openrouter/nousresearch/hermes-3-llama-3.1-405b:free}"
echo "model: ${MODEL}" > "$HERMES_HOME/config.yaml"

echo "[entrypoint] Starting Hermes Gateway..."
export PYTHONUNBUFFERED=1
exec hermes gateway run -vv 2>&1
```

### `.gitattributes`

```
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
*.webp filter=lfs diff=lfs merge=lfs -text
```

---

## Step 3: Create a Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**
2. Select your workspace, paste this manifest, click **Create**:

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

3. After creation, go to **Socket Mode** (left sidebar) → toggle **On**
4. Go to **Event Subscriptions** → toggle **On** → **Subscribe to bot events** → **Add Bot User Event** → add `message.im` → **Save Changes**
5. Go to **OAuth & Permissions** → **Install to Workspace** → copy **Bot Token** (`xoxb-...`)
6. Go to **Basic Information** → **App-Level Tokens** → **Generate Token** → name it `socket-token` → add `connections:write` scope → copy token (`xapp-...`)

---

## Step 4: Set HF Space Secrets

In your HF Space → **Settings** → **Repository Secrets**, add:

| Secret | Description |
|--------|-------------|
| `SLACK_BOT_TOKEN` | Bot token from Step 3.5 (`xoxb-...`) |
| `SLACK_APP_TOKEN` | App-level token from Step 3.6 (`xapp-...`) |
| `SLACK_ALLOWED_USERS` | Your Slack member ID (find in Slack profile → **More** → **Copy Member ID**) |
| `GATEWAY_ALLOW_ALL_USERS` | Set to `true` (bypasses pairing; reduces to `false` after testing) |

### Add one LLM provider:

| Secret | Description |
|--------|-------------|
| `GEMINI_API_KEY` | Free from https://aistudio.google.com/apikey (no credit card) |
| `MODEL` | `gemini/gemini-2.0-flash` |

Or choose another:

| Secret | Model Secret | MODEL value |
|--------|--------------|-------------|
| Gemini | `GEMINI_API_KEY` | `gemini/gemini-2.0-flash` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/model-name` |
| OpenCode Zen | `OPENCODE_ZEN_API_KEY` | `opencode/big-pickle` |

---

## Step 5: Deploy

Push the three files to your Space's `main` branch:

```bash
cd your-local-repo
git init
git add .
git commit -m "Initial Hermes HF Space setup"
git remote add origin https://huggingface.co/spaces/YOUR_USERNAME/hermes
git push origin main
```

The Space builds automatically. Watch build logs in the **Builder** tab (≈2-5 min).

---

## Step 6: Connect & Chat

1. Go to your Space → **App** tab → check runtime logs for:
   ```
   [Slack] Authenticated as @Personal-Bot in workspace ...
   ✓ slack connected
   ⚡️ Bolt app is running!
   ```
2. Open Slack → click **Personal-Bot** under **Apps** in the sidebar → send **hello**
3. The bot responds

---

## Adding more users

Anyone in your workspace can DM the bot. It sends a **one-time pairing code**. Share the code with you; approve with:

```
hermes pairing approve slack <CODE>
```

Codes expire after 1 hour.

---

## Overriding the model

Set `MODEL` secret in HF Space to override the default. Common values:

- `gemini/gemini-2.0-flash`
- `opencode/big-pickle`
- `openai/gpt-4o`
- `anthropic/claude-sonnet-4-20250514`
- `openrouter/mistralai/mistral-7b-instruct:free`

---

## Changing the bot name

Edit the Slack app manifest (api.slack.com → your app → **App Manifest**) and reinstall.

---

## Removing GATEWAY_ALLOW_ALL_USERS

Once you've approved users via pairing, set `GATEWAY_ALLOW_ALL_USERS` to `false` (or remove it) so only paired users can DM.
