#!/bin/bash
set -euo pipefail

# Session data is persisted via mounted volume at /data
# (miteshtrivedi10/aoe-agent-orchestrator-storage is mounted at /data).
# /data/repos holds repo clones, /data/kilo holds Kilo config.
mkdir -p /data/kilo/auth /data/kilo/state /data/repos

# Git safe.directory — /data is HF persistent storage, may have mismatched UID
git config --global safe.directory '*'

echo "=== ENTRYPOINT DEBUG ==="
echo "kilo version: $(kilo --version 2>/dev/null || echo 'unknown')"
echo "KILO_AUTH_TOKEN set: $( [ -n "${KILO_AUTH_TOKEN:-}" ] && echo 'yes' || echo 'no')"
echo "KILO_REMOTE set: ${KILO_REMOTE:-not-set}"
# Setup Kilo data dirs — always needed for persistence
mkdir -p /root/.config /root/.local/share
rm -rf /root/.config/kilo /root/.local/share/kilo
ln -sf /data/kilo /root/.config/kilo
ln -sf /data/kilo /root/.local/share/kilo

if [ -n "${KILO_AUTH_TOKEN:-}" ]; then
    # Write auth.json with correct Kilo Gateway format.
    # The CLI auth loader checks `kilo.type` to determine how to extract the token:
    #   type="oauth" → uses kilo.access as Bearer token
    #   type="api"   → uses kilo.key as Bearer token
    # Without the type field, the loader cannot authenticate with the Gateway
    # and the relay WebSocket never connects — sessions stay invisible.
    python3 -c "
import json, os, sys

raw = os.environ.get('KILO_AUTH_TOKEN', '').strip()
auth_path = '/data/kilo/auth.json'

# Try parsing as JSON first (full OAuth response from kilo auth login)
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    data = None

if data is not None and isinstance(data, dict):
    # It's a JSON blob — normalise into kilo namespace
    if 'kilo' in data:
        # Already has kilo namespace (e.g. from kilo auth login export)
        kilo = data['kilo']
    elif 'access' in data:
        # Top-level access/refresh — wrap under kilo
        kilo = data
        data = {'kilo': kilo}
    else:
        kilo = data.get('kilo', data)

    # Ensure type field exists — default to oauth if access/refresh present
    if 'type' not in kilo:
        if 'access' in kilo:
            kilo['type'] = 'oauth'
        elif 'key' in kilo:
            kilo['type'] = 'api'
        else:
            # Unknown format — assume oauth with the raw value
            kilo['type'] = 'oauth'
            kilo['access'] = raw
            kilo['refresh'] = raw
else:
    # Plain string token — use as API key (type=api)
    # This is the format for KILO_API_KEY / raw gateway tokens
    data = {'kilo': {'type': 'api', 'key': raw}}

# Ensure expires field for oauth type (1 year from now)
kilo = data.get('kilo', data)
if kilo.get('type') == 'oauth' and 'expires' not in kilo:
    import time
    kilo['expires'] = int(time.time() * 1000) + (365 * 24 * 60 * 60 * 1000)

# Write with correct permissions
json.dump(data, open(auth_path, 'w'))
os.chmod(auth_path, 0o600)

# Debug: print auth structure (key names only, never values)
for k, v in data.items():
    if isinstance(v, dict):
        print(f'auth.{k} keys={list(v.keys())} present=true', flush=True)
    else:
        print(f'auth.{k} present=true', flush=True)
" 2>&1 | while read line; do echo "  auth-debug: $line"; done
else
    echo "KILO_AUTH_TOKEN not set — use web UI 'Login to Kilo Gateway' button for interactive auth"
fi

# Always write config.json with remote_control enabled
python3 -c "
import json, os
cfg_path = '/data/kilo/config.json'
cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
cfg['remote_control'] = True
json.dump(cfg, open(cfg_path, 'w'))
print(f'config.json: {json.dumps(cfg)}', flush=True)
" 2>&1 | while read line; do echo "  config-debug: $line"; done

# Set KILO_REMOTE=1 so TUI auto-enables remote WebSocket
export KILO_REMOTE=1
echo "KILO_REMOTE set to 1"

# Note: KILO_API_KEY / KILO_AUTH_TOKEN env vars are NOT exported.
# Auth is served via /data/kilo/auth.json (symlinked to ~/.config/kilo/).
# Exporting the full token as an env var would leak it to child processes and logs.

# ── Start Flask FIRST — HF health check needs port 7860 up fast ────
echo "Starting Flask web app on port 7860..."
/opt/venv/bin/python app.py &
FLASK_PID=$!
# Give Flask a moment to bind the port
sleep 2

# ── Kilo daemon setup (runs after Flask is already serving) ─────────
echo "Starting Kilo daemon..."
DAEMON_LOG="/data/kilo/daemon.log"
kilo daemon start --foreground >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
echo "Daemon PID: $DAEMON_PID"

# Give daemon time to stabilize and connect to Gateway
sleep 8

# Check daemon status (redirect output to daemon log, not stdout — logs are public)
kilo daemon status --json >>"$DAEMON_LOG" 2>&1 || true

# Enable Gateway relay at daemon level.
# `kilo remote` tells the daemon to establish a WebSocket relay to api.kilo.ai.
# Without this, the daemon is local-only and sessions are invisible to the Cloud Dashboard.
echo "Enabling Gateway relay via 'kilo remote'..."
kilo remote 2>&1 | while read line; do echo "  remote: $line"; done || echo "  remote: command failed (non-fatal)"
sleep 3

# Verify Gateway connectivity
echo "Gateway connectivity check:"
python3 -c "
import urllib.request, json, sys
try:
    req = urllib.request.Request('https://api.kilo.ai/api/profile', method='GET')
    # Don't send auth — just check if the endpoint is reachable
    resp = urllib.request.urlopen(req, timeout=5)
    print(f'  api.kilo.ai reachable: HTTP {resp.status}')
except urllib.error.HTTPError as e:
    # 401 is expected without auth — it means the server is reachable
    print(f'  api.kilo.ai reachable: HTTP {e.code} (auth required — expected)')
except Exception as e:
    print(f'  api.kilo.ai UNREACHABLE: {e}')
    print(f'  WARNING: Sessions will NOT appear in Cloud Dashboard without Gateway connectivity')
" 2>&1 | while read line; do echo "$line"; done

# Check daemon log for relay evidence (no raw log output to public stdout)
if grep -qi "relay\|gateway\|remote\|connected\|websocket\|cloud" "$DAEMON_LOG" 2>/dev/null; then
    echo "  Daemon relay: CONNECTED"
else
    echo "  Daemon relay: NOT DETECTED (sessions may not appear in Cloud Dashboard)"
fi

echo "Kilo setup complete. Flask is already serving on port 7860."

# Keep container alive — wait for any child process (Flask, daemon) to exit
wait
