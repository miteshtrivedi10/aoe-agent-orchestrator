#!/bin/bash
set -e

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"

# Write all relevant env vars to .env so hermes gateway picks them up.
# This catches provider keys, bot tokens, gateway config, etc.
# We only write vars likely relevant to Hermes (common prefixes).
ENV_FILE="$HERMES_HOME/.env"
touch "$ENV_FILE"

# Clear stale entries (rewrite from scratch)
> "$ENV_FILE"

for var in $(compgen -e); do
  case "$var" in
    HERMES_*|HF_*|OPENAI_*|OPENROUTER_*|ANTHROPIC_*|DEEPSEEK_*|\
    GOOGLE_*|GEMINI_*|GITHUB_*|GITLAB_*|XAI_*|NOVITA_*|NVIDIA_*|\
    AZURE_*|AWS_*|BEDROCK_*|DASHSCOPE_*|KIMI_*|MINIMAX_*|Z_AI_*|\
    GLM_*|ARCEEAI_*|GMI_*|STEPFUN_*|XIAOMI_*|TOKENHUB_*|OLLAMA_*|OPENCODE_*|\
    TELEGRAM_*|DISCORD_*|SLACK_*|SIGNAL_*|WHATSAPP_*|MATRIX_*|\
    MATTERMOST_*|DINGTALK_*|FEISHU_*|WECOM_*|WEIXIN_*|QQ_*|\
    BLUEBUBBLES_*|TEAMS_*|LINE_*|EMAIL_*|GATEWAY_*|SMS_*|\
    HOME_ASSISTANT_*|NTFY_*|YUANBAO_*|\
    N8N_*|LINEAR_*|\
    MODEL|LM_*|COPILOT_*|CODEBOX_*)
      val="${!var}"
      if [ -n "$val" ]; then
        echo "$var=$val" >> "$ENV_FILE"
      fi
      ;;
  esac
done

echo "[entrypoint] Wrote $(wc -l < "$ENV_FILE") vars to $ENV_FILE"
echo "[entrypoint] .env var names: $(cut -d= -f1 "$ENV_FILE" | tr '\n' ' ')"

# Write default model to config.yaml (direct write — CLI may not support top-level model key)
if [ -n "${MODEL:-}" ]; then
  echo "model: ${MODEL}" >> "$HERMES_HOME/config.yaml"
fi

# Configure Slack in config.yaml (uses env var references, not plaintext)
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  hermes config set platforms.slack.bot_token "\$SLACK_BOT_TOKEN"
  hermes config set platforms.slack.app_token "\$SLACK_APP_TOKEN"
  hermes config set platform_toolsets.slack '["hermes-slack"]'
fi

# Diagnostic: show config.yaml (mask secrets)
echo "[entrypoint] config.yaml model: $(grep '^model:' "$HERMES_HOME/config.yaml" 2>/dev/null || echo 'NOT SET')"

echo "[entrypoint] Starting Hermes Gateway (verbose)..."
export PYTHONUNBUFFERED=1
exec hermes gateway run -vv 2>&1
