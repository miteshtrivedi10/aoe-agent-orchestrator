FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && update-ca-certificates

RUN npm install -g @kilocode/cli

WORKDIR /app

COPY package.json /app/
ENV PYTHON=/usr/bin/python3
RUN npm install

COPY server.js /app/
COPY templates/ /app/templates/
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/app/entrypoint.sh"]
