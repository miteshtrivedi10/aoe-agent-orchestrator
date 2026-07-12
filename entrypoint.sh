#!/bin/bash
set -euo pipefail

# Session data is persisted via mounted volume at /data
mkdir -p /data/kilo /data/repos /data/installs

# ── Runtime tool PATH ───────────────────────────────────────
# Pre-installs (Python 3.12/3.14, OpenJDK 21, Node 22+) are downloaded
# once into /data/installs/<tool>/<version> at container boot. Prepend their
# bin dirs so the Node server AND every spawned Kilo PTY session can find
# them. Dir.s that don't exist yet (first boot, install still running) are
# simply skipped by the shell — harmless until the binaries land.
export PATH="/data/installs/node/22/bin:/data/installs/python/3.14/bin:/data/installs/python/3.12/bin:/data/installs/java/21/bin:$PATH"

# Git safe.directory — /data is HF persistent storage, may have mismatched UID
git config --global safe.directory '*'

# Git identity — required by git commit and pre-commit hooks. The agent uses this
# as the committer name/email. Override via GIT_USER_NAME and GIT_USER_EMAIL env vars.
git config --global user.name "${GIT_USER_NAME:-Agent Dock}"
git config --global user.email "${GIT_USER_EMAIL:-agent-dock@local}"

# ── GitHub Credentials for Push ──────────────────────────────────
# When GITHUB_TOKEN is provided (HF secret or env var), configure git so that
# pushes to github.com are authenticated automatically. `url.<base>.insteadOf`
# rewrites every https://github.com/... remote URL to embed the token at fetch
# AND push time. This covers the session's cloned work tree (whose origin may
# not contain credentials) so agent pushes succeed once the user grants the
# push permission. Username is irrelevant to GitHub; the token is used as the
# password. Never log the token.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  echo "=== GitHub credentials configured (insteadOf) — agent pushes to github.com will authenticate ==="
else
  echo "=== No GITHUB_TOKEN set — agent cannot push to private github.com repos (clone is anonymous) ==="
fi

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
      echo "  $key - Available"
    fi
  done < <(node -e "
    const s = JSON.parse(process.env.HF_SECRETS || '{}');
    Object.entries(s).forEach(([k,v]) => console.log(k + '=' + v));
  " 2>/dev/null || echo "")
else
  echo "=== No HF_SECRETS found — secrets must be set as individual env vars ==="
fi

# Permanent snapshot disable for every kilo process in the container.
# KILO_CONFIG_CONTENT is merged LAST by kilo's config loader and overrides
# all config files (global + project) and most organization config.
export KILO_CONFIG_CONTENT='{"snapshot":false}'

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
