#!/bin/bash
set -e

WORKSPACE="${WORKSPACE:-/workspace}"
AOE_DATA_DIR="${AOE_DATA_DIR:-${WORKSPACE}/.aoe}"

mkdir -p "$WORKSPACE" "$AOE_DATA_DIR"

# Ensure aoe is on PATH
export PATH="/root/.local/bin:${PATH}"

AOE_PASSPHRASE="${AOE_PASSPHRASE:-}"

echo "[entrypoint] Starting AoE web dashboard on :7860"

# Run in FOREGROUND — HF Spaces needs PID 1 to be the HTTP server
if [ -n "$AOE_PASSPHRASE" ]; then
  exec aoe serve --host 0.0.0.0 --port 7860 --auth=passphrase --passphrase "$AOE_PASSPHRASE"
else
  exec aoe serve --host 0.0.0.0 --port 7860
fi
