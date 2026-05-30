# 24/7 bot runner — deploy to a small VPS/container near Polymarket's infra to maximize
# capture (uptime is the single biggest odds-mover for a non-HFT client).
# Build:  docker build -t pm-bot ./bot
# Run:    docker run -d --restart=always --env-file ./bot/.env --name pm-bot pm-bot
#         (paper by default; live only if your .env has the triple opt-in)
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
# safety: never bake secrets into the image — .env is mounted at runtime via --env-file
ENV NODE_ENV=production
CMD ["node", "index.js"]
