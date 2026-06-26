FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system deps: tmux for session management, git for repos
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tmux \
    && rm -rf /var/lib/apt/lists/* && \
    rm -rf /var/cache/apt/*

# Install opencode (standalone binary — not an npm package)
RUN curl -fsSL https://github.com/anomalyco/opencode/releases/download/v1.17.11/opencode-linux-x64.tar.gz -o /tmp/opencode.tar.gz \
    && tar xzf /tmp/opencode.tar.gz -C /tmp \
    && find /tmp -name "opencode" -type f -executable -exec mv {} /usr/local/bin/opencode \; \
    && rm -rf /tmp/opencode.tar.gz /tmp/opencode*

# Install Agent of Empires (release binary with embedded web dashboard)
RUN curl -fsSL https://raw.githubusercontent.com/agent-of-empires/agent-of-empires/main/scripts/install.sh | bash

# Ensure aoe is on PATH (install script puts it in /root/.local/bin)
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /workspace

COPY opencode.jsonc /root/.config/opencode/opencode.jsonc
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/entrypoint.sh"]
