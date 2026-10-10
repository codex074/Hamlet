# Hamlet game server: static game files + JSON API, no npm dependencies.
FROM node:24-alpine
WORKDIR /app
COPY index.html ./
COPY src ./src
COPY vendor ./vendor
COPY server ./server
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8090 HOST=0.0.0.0 DATA_DIR=/data ROOT_DIR=/app TRUST_PROXY=1
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/api/config || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
