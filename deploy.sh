#!/bin/sh
# Deploy Hamlet to the Hostinger VPS: upload the game + server, rebuild and restart the container.
# Usage: ./deploy.sh            (requires the "hostinger" host in ~/.ssh/config)
set -eu
cd "$(dirname "$0")"
HOST=${DEPLOY_HOST:-hostinger}
DIR=/srv/hamlet/app

echo "▶ running tests"
npm test --silent >/dev/null 2>&1 || { echo "✖ tests failed — not deploying"; exit 1; }

echo "▶ uploading to $HOST:$DIR"
ssh "$HOST" "mkdir -p $DIR /srv/hamlet/data && chown 1000:1000 /srv/hamlet/data && touch /srv/hamlet/hamlet.env"
rsync -az --delete --exclude-from=.dockerignore \
  index.html privacy.html manifest.webmanifest sw.js icons src vendor server Dockerfile docker-compose.yml .dockerignore "$HOST:$DIR/"

echo "▶ building and restarting"
ssh "$HOST" "cd $DIR && docker compose up -d --build && docker image prune -f >/dev/null"

echo "▶ health check"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ssh "$HOST" "curl -fsS http://127.0.0.1:8090/api/config" >/dev/null 2>&1; then
    echo "✔ Hamlet is up: https://hamlet.codex074.com"; exit 0
  fi
  sleep 2
done
echo "✖ server did not answer — check: ssh $HOST 'docker logs hamlet-server --tail 50'"; exit 1
