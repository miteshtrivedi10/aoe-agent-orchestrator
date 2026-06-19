FROM debian:12-slim

LABEL org.opencontainers.image.source="https://github.com/NousResearch/hermes-agent"
LABEL org.opencontainers.image.description="Hermes Agent — the self-improving AI agent by Nous Research"

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system deps needed by the Hermes installer:
#   git        — required
#   xz-utils   — needed to extract node-v22*.tar.xz
#   bzip2      — some tool archives use bz2
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    xz-utils && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /var/cache/apt/*

# Install Hermes Agent via official installer
# --skip-setup avoids the interactive provider/model wizard
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup

ENV PATH="/root/.local/bin:${PATH}"
ENV HERMES_HOME="/root/.hermes"

WORKDIR /root

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/entrypoint.sh"]
