#!/bin/sh
# Serve Hamlet on port 8080 (open http://localhost:8080)
cd "$(dirname "$0")" && exec python3 -m http.server "${PORT:-8080}"
