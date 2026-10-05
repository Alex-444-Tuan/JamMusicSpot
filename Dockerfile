# JamMusicSpot — production image (Express + Socket.IO + static public/).
FROM node:24-alpine

WORKDIR /app

# Dependencies first so this layer is cached until package*.json change.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code. Owned by root but world-readable (COPY keeps source modes, which are
# 644/755 in this repo); the node user only needs to read it, never write.
COPY src ./src
COPY public ./public
RUN chmod -R a+rX /app/src /app/public

ENV NODE_ENV=production \
    PORT=8080
EXPOSE 8080

USER node

# busybox wget ships with alpine; /healthz returns 503 when Redis is down.
# 127.0.0.1, not localhost: alpine resolves localhost to ::1 first, and the
# server listens on 0.0.0.0 (IPv4 only), so localhost always failed.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
