FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libglib2.0-0 libdbus-1-3 \
    libx11-xcb1 libxcb-dri3-0 fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
RUN npx playwright install chromium
COPY server.js ./

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE ${PORT}

CMD ["node", "server.js"]
