---
title: Agent of Empires
emoji: 🏛️
colorFrom: gray
colorTo: yellow
sdk: docker
pinned: false
---

# Agent of Empires on Hugging Face Spaces

[Agent of Empires](https://github.com/agent-of-empires/agent-of-empires) — session manager for AI coding agents. Run many agents in parallel across different branches, each in its own isolated tmux session. Access from any browser via the web dashboard.

---

## Prerequisites

- HF Space (Private, Docker SDK)
- An LLM API key for opencode (OpenAI, Anthropic, Gemini, OpenRouter, etc.)

---

## Step 1: Create HF Space

1. Go to https://huggingface.co/new-space
2. **Name:** `aoe` (or your choice)
3. **License:** MIT
4. **SDK:** Docker
5. **Visibility:** Private
6. **Hardware:** CPU (upgrade to GPU if needed for faster agents)
7. **Create Space**

---

## Step 2: Push Files

Push these 3 files to your Space: `Dockerfile`, `entrypoint.sh`, `.gitattributes`

---

## Step 3: Set HF Space Secrets

In **Settings → Repository Secrets**, add:

| Secret | Description |
|--------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (for opencode) |
| `ANTHROPIC_API_KEY` | Anthropic API key (optional, for Claude Code) |
| `AOE_PASSPHRASE` | Passphrase for web dashboard login (optional — without it, a token URL is used) |
| `WORKSPACE` | `/workspace` (default) |

---

## Step 4: Deploy

```bash
git init
git add .
git commit -m "Deploy Agent of Empires on HF Spaces"
git remote add origin https://huggingface.co/spaces/YOUR_USERNAME/aoe
git push origin main
```

Wait for the build (~2-5 min).

---

## Step 5: Access the Web Dashboard

1. Go to your Space → **App** tab
2. Check logs for:
   ```
   [entrypoint] Starting AoE web dashboard with passphrase auth on :7860
   ================================================
     Agent of Empires — Web Dashboard
   ================================================
     https://your-space.hf.space/?token=abc123...
   ================================================
   ```
3. Open the URL in your browser

If `AOE_PASSPHRASE` is set, you'll see a passphrase login screen instead of a token URL.

---

## Step 6: Create Your First Session

In the web dashboard:

1. Click **New Session** (or use `aoe add` in the Space's terminal)
2. Choose a repository or scratch directory
3. Select **opencode** as the agent
4. Click **Launch**

Or from the Space's terminal (via the **Terminal** tab in HF Space):

```bash
# List available agents
aoe agents

# Create a session in a git repo
aoe add --cmd opencode --worktree feature/my-feature /workspace/my-repo

# Start the session
aoe session start <session-id>
```

---

## Supported Agents

| Agent | Command | Install |
|-------|---------|---------|
| OpenCode | `opencode` | ✅ Pre-installed |
| Claude Code | `claude` | Add `ANTHROPIC_API_KEY` secret |
| Codex CLI | `codex` | Add `OPENAI_API_KEY` secret |
| Gemini CLI | `gemini` | Add `GEMINI_API_KEY` secret |
| Copilot CLI | `copilot` | Add `GITHUB_TOKEN` secret |

---

## How It Works

Each agent runs in its own **tmux session**, so work survives container restarts (within the ephemeral filesystem limit). The web dashboard provides:

- **Terminal view** — raw tmux rendering of the agent
- **Structured view** — ACP-native rendering (plan panels, tool-call cards)
- **Diff view** — review git changes inline
- **Session management** — start, stop, rename, archive sessions
- **Sound notifications** — alert when agent needs input

---

## Limitations on HF Spaces

| Limitation | Workaround |
|-----------|-----------|
| Ephemeral filesystem — sessions lost on restart | Accept or use persistent HF storage (coming soon) |
| No Docker-in-Docker — `--sandbox` unavailable | Run agents directly in tmux |
| 2vCPU / 16GB RAM — 3-5 concurrent agents max | Use lightweight agents (opencode) |
| No persistent SSH | Use web dashboard only |

---

## Useful Commands

```bash
# List sessions
aoe list

# Check status
aoe status

# Send message to running session
aoe send <session-id> "Refactor the auth module"

# Capture session output
aoe session capture <session-id> --lines 50

# Kill all sessions (nuclear option)
aoe killall

# View logs
aoe logs --follow
```

---

## Configuration

| Env Var | Description |
|---------|-------------|
| `WORKSPACE` | Base directory for repos and worktrees (default: `/workspace`) |
| `AOE_DATA_DIR` | AoE app data directory (default: `/workspace/.aoe`) |
| `AOE_PASSPHRASE` | Passphrase for web dashboard (optional) |
