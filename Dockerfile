FROM node:22-slim

# cloakbrowser downloads its own patched Chromium, but that binary still needs
# the usual system libraries present in the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
      libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
      libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
      libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 xdg-utils wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Chromium sandboxing needs privileges this container does not have, and
# running the browser as root is worse. Drop to the image's node user.
RUN mkdir -p /home/node/.cache && chown -R node:node /app /home/node
USER node

ENV NODE_ENV=production
EXPOSE 3000

# Warm the binary at build time so the first request is not the one that waits
# 40 seconds for a 200MB download.
RUN node -e "import('cloakbrowser').then(m => m.ensureBinary())" || true

CMD ["node", "src/server.js"]
