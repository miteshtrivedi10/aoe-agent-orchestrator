FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
RUN npm install -g @kilocode/cli --no-optional \
    && npm cache clean --force \
    && find /usr/local/lib/node_modules \( -name '*.md' -o -name '*.ts' -o -name '*.map' -o -name '*.flow' -o -name '*.tsbuildinfo' -o -name 'binding.gyp' -o -name 'Makefile' -o -name 'makefile' -o -name '*.mk' \) -delete \
    && find /usr/local/lib/node_modules \( -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'spec' -o -name 'specs' -o -name 'docs' -o -name 'doc' -o -name 'examples' -o -name 'example' -o -name 'benchmark' -o -name 'benchmarks' -o -name 'fixtures' -o -name '.cache' \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /usr/local/lib/node_modules -name 'prebuilds' -type d -exec sh -c 'for d in "$@"; do for p in "$d"/*/; do case "$(basename "$p")" in linux*|linux-x64|linux-x86_64) ;; *) rm -rf "$p";; esac; done; done' _ {} + 2>/dev/null || true

WORKDIR /app
COPY package.json /app/
RUN npm install --omit=dev --no-optional \
    && npm cache clean --force \
    && find node_modules \( -name '*.md' -o -name '*.ts' -o -name '*.map' -o -name '*.flow' -o -name '*.tsbuildinfo' -o -name 'binding.gyp' -o -name 'Makefile' -o -name '*.mk' \) -delete \
    && find node_modules \( -name 'test' -o -name 'tests' -o -name '__tests__' -o -name 'spec' -o -name 'docs' -o -name 'examples' -o -name 'benchmark' -o -name 'benchmarks' -o -name 'fixtures' -o -name '.cache' \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find node_modules -name 'prebuilds' -type d -exec sh -c 'for d in "$@"; do for p in "$d"/*/; do case "$(basename "$p")" in linux*|linux-x64|linux-x86_64) ;; *) rm -rf "$p";; esac; done; done' _ {} + 2>/dev/null || true

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/ /usr/local/bin/
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /app/node_modules /app/node_modules

WORKDIR /app

COPY server.js /app/
COPY lib/ /app/lib/
COPY templates/ /app/templates/
COPY entrypoint.sh /app/entrypoint.sh
COPY kilo.jsonc /app/kilo.jsonc

RUN chmod +x /app/entrypoint.sh

EXPOSE 7860
ENTRYPOINT ["/app/entrypoint.sh"]