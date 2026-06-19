#!/bin/bash
set -e

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME"

# Write all relevant env vars to .env so hermes gateway picks them up.
ENV_FILE="$HERMES_HOME/.env"
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

echo "[entrypoint] Wrote $(wc -l < "$ENV_FILE") vars"
echo "[entrypoint] .env names: $(cut -d= -f1 "$ENV_FILE" | tr '\n' ' ')"

# Write model to config.yaml
MODEL="${MODEL:-openrouter/nousresearch/hermes-3-llama-3.1-405b:free}"
echo "model: ${MODEL}" > "$HERMES_HOME/config.yaml"
echo "[entrypoint] model: ${MODEL}"

echo "[entrypoint] Starting Hermes Gateway..."
export PYTHONUNBUFFERED=1
exec hermes gateway run -vv 2>&1
