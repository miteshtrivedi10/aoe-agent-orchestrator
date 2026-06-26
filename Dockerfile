FROM node:20

RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @kilocode/cli

WORKDIR /app

COPY package.json /app/
RUN npm install

COPY server.js /app/
COPY templates/ /app/templates/
COPY entrypoint.sh /app/entrypoint.sh

RUN chmod +x /app/entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["/app/entrypoint.sh"]
