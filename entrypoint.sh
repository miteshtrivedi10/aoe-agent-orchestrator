#!/bin/bash
set -e

WORKSPACE="${WORKSPACE:-/workspace}"
AOE_DATA_DIR="${AOE_DATA_DIR:-${WORKSPACE}/.aoe}"

mkdir -p "$WORKSPACE" "$AOE_DATA_DIR"

# Ensure aoe is on PATH
export PATH="/root/.local/bin:${PATH}"

# Set passphrase from env (recommended for HF Spaces behind proxy)
AOE_PASSPHRASE="${AOE_PASSPHRASE:-}"

# Start the web dashboard
# --host 0.0.0.0  : bind to all interfaces (required for HF Spaces)
# --port 7860     : HF Spaces default exposed port
# --daemon        : run in background so we can do one-time setup
# --auth mode:
#   If AOE_PASSPHRASE is set: use passphrase auth (cleaner than token URL)
#   Otherwise: use default token auth
if [ -n "$AOE_PASSPHRASE" ]; then
  echo "[entrypoint] Starting AoE web dashboard with passphrase auth on :7860"
  aoe serve --host 0.0.0.0 --port 7860 --auth=passphrase --passphrase "$AOE_PASSPHRASE" --daemon
else
  echo "[entrypoint] Starting AoE web dashboard with token auth on :7860"
  echo "[entrypoint] Set AOE_PASSPHRASE secret for cleaner login (no token URL needed)"
  aoe serve --host 0.0.0.0 --port 7860 --daemon
fi

# Wait for daemon to be ready
sleep 4

# Print dashboard info
echo "================================================"
echo "  Agent of Empires — Web Dashboard"
echo "================================================"
aoe url --all 2>/dev/null || aoe url 2>/dev/null || true
echo ""
echo "  Port: 7860"
echo "  Data dir: $AOE_DATA_DIR"
echo "  Agents: opencode (verified: $(which opencode 2>/dev/null && echo 'found' || echo 'missing'))"
echo "================================================"

# Keep container running — tail the aoed log
AOE_LOG_DIR="$AOE_DATA_DIR/logs"
mkdir -p "$AOE_LOG_DIR"
tail -f "$AOE_LOG_DIR"/*.log 2>/dev/null || \
  tail -f /dev/null 2>/dev/null || \
  sleep infinity
