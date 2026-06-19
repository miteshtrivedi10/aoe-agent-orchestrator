FROM python:3.11-slim

LABEL org.opencontainers.image.source="https://github.com/NousResearch/hermes-agent"
LABEL org.opencontainers.image.description="Hermes Agent — the self-improving AI agent by Nous Research"

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system deps: git for skills/tools, others for browser tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    ripgrep \
    ffmpeg \
    xz-utils && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /var/cache/apt/*

# Install Hermes Agent with messaging extras (includes slack-bolt, slack-sdk)
RUN pip install --no-cache-dir --break-system-packages "hermes-agent[all,messaging]"

ENV HERMES_HOME="/root/.hermes"

WORKDIR /root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/entrypoint.sh"]
