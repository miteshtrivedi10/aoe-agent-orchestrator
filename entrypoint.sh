#!/bin/bash
set -euo pipefail

# Session data is persisted via mounted volume at /data
mkdir -p /data/kilo /data/repos

# Git safe.directory — /data is HF persistent storage, may have mismatched UID
git config --global safe.directory '*'

# Kilo data dirs
mkdir -p /root/.config /root/.local/share
rm -rf /root/.config/kilo /root/.local/share/kilo
ln -sf /data/kilo /root/.config/kilo
ln -sf /data/kilo /root/.local/share/kilo

echo "=== HERMES-CLOUD ENTRYPOINT ==="

# Start NodeJS server — handles auth, daemon, remote, and HTTP
echo "Starting NodeJS server on port 7860..."
node /app/server.js &

SERVER_PID=$!

# Give server time to bind port (HF health check)
sleep 3

echo "Server started (PID $SERVER_PID). Container alive."
wait
