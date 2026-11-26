FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Shipyard runs check containers as an unprivileged user with isolated networking.
RUN printf '%s\n' '#!/bin/sh' 'exec /usr/bin/chromium --no-sandbox "$@"' > /usr/local/bin/shipyard-chromium \
    && chmod 755 /usr/local/bin/shipyard-chromium

ENV CHROME_PATH=/usr/local/bin/shipyard-chromium
