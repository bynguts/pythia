# syntax=docker/dockerfile:1

# Build context: deploy/wa-gateway, source as named context "app".

FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app
COPY --from=app package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY --from=app . .

# Baileys session persists in /app/baileys_auth_info — mount a volume.
EXPOSE 2785

CMD ["node", "server.js"]
