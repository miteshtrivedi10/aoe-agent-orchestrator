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
    GLM_*|ARCEEAI_*|GMI_*|STEPFUN_*|XIAOMI_*|TOKENHUB_*|OLLAMA_*|\
    TELEGRAM_*|DISCORD_*|SLACK_*|SIGNAL_*|WHATSAPP_*|MATRIX_*|\
    MATTERMOST_*|DINGTALK_*|FEISHU_*|WECOM_*|WEIXIN_*|QQ_*|\
    BLUEBUBBLES_*|TEAMS_*|LINE_*|EMAIL_*|GATEWAY_*|SMS_*|\
    HOME_ASSISTANT_*|NTFY_*|YUANBAO_*|\
    N8N_*|LINEAR_*|\
    LM_*|COPILOT_*|CODEBOX_*)
      val="${!var}"
      if [ -n "$val" ]; then
        echo "$var=$val" >> "$ENV_FILE"
      fi
      ;;
  esac
done

echo "[entrypoint] Wrote $(wc -l < "$ENV_FILE") vars to $ENV_FILE"

# If MODEL env var is set, configure the model
if [ -n "${MODEL:-}" ]; then
  hermes config set model "$MODEL" 2>/dev/null || true
fi

echo "[entrypoint] Starting Hermes Gateway..."

exec hermes gateway
