#!/bin/sh
# Serve Hamlet on port 8080. Default: this machine only (http://localhost:8080).
# To play from another Mac over Tailscale: BIND=<tailscale-ip> ./serve.sh
cd "$(dirname "$0")" && exec python3 -m http.server "${PORT:-8080}" --bind "${BIND:-127.0.0.1}"
