#!/bin/bash
set -euo pipefail

# Session data is persisted via mounted volume at /data
mkdir -p /data/kilo /data/repos

# Git safe.directory — /data is HF persistent storage, may have mismatched UID
git config --global safe.directory '*'

# ── HF Secrets Injection ────────────────────────────────────────────
# Hugging Face Spaces inject secrets via the HF_SECRETS env var as a single
# JSON blob containing all secret keys together, e.g.:
#   HF_SECRETS='{"CONTEXT7_API_KEY":"sk-...","GEMINI_API_KEY":"...","JINA_API_KEY":"..."}'
# We parse this JSON and export each key as a separate environment variable
# so that kilo.jsonc {env:VAR_NAME} placeholder resolution works at runtime.
if [ -n "${HF_SECRETS:-}" ]; then
  echo "=== Injecting HF Secrets ==="
  while IFS='=' read -r key value; do
    if [ -n "$key" ]; then
      export "$key"="$value"
      echo "  Exported $key (${#value} chars)"
    fi
  done < <(node -e "
    const s = JSON.parse(process.env.HF_SECRETS || '{}');
    Object.entries(s).forEach(([k,v]) => console.log(k + '=' + v));
  " 2>/dev/null || echo "")
else
  echo "=== No HF_SECRETS found — secrets must be set as individual env vars ==="
fi

# Kilo data dirs
mkdir -p /root/.config /root/.local/share
rm -rf /root/.config/kilo /root/.local/share/kilo
ln -sf /data/kilo /root/.config/kilo
ln -sf /data/kilo /root/.local/share/kilo

# Kill any zombie kilo processes from previous restarts
# (HF Space persistent storage preserves processes across restarts sometimes,
# and old kilo daemon/remote/serve/TUI processes can conflict with new ones)
# pkill -x matches process name exactly — kills all kilo-* executables
echo "=== Cleaning up zombie kilo processes ==="
pkill -x kilo 2>/dev/null || true
sleep 1

echo "=== HERMES-CLOUD ENTRYPOINT ==="

# Start NodeJS server — handles auth, daemon, remote, and HTTP
echo "Starting NodeJS server on port 7860..."
node /app/server.js &

SERVER_PID=$!

# Give server time to bind port (HF health check)
sleep 3

echo "Server started (PID $SERVER_PID). Container alive."
wait
