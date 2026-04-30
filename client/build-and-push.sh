#!/usr/bin/env bash
set -euo pipefail

# Builds the Next.js production image for linux/amd64 and pushes to
# Docker Hub. Run from the client/ directory:
#
#   ./build-and-push.sh
#
# Override BACKEND_PUBLIC_URL when the backend hostname changes.

BACKEND_PUBLIC_URL="${BACKEND_PUBLIC_URL:-https://vita-npd-backend-d6gkh9ehf8cwftfq.westeurope-01.azurewebsites.net}"
IMAGE="${IMAGE:-maksymcherhyk/vita-npd-frontend:latest}"

echo "[build] backend URL : ${BACKEND_PUBLIC_URL}"
echo "[build] image       : ${IMAGE}"

docker buildx build \
    --platform linux/amd64 \
    --progress=plain \
    --build-arg "NEXT_PUBLIC_API_URL=${BACKEND_PUBLIC_URL}" \
    --build-arg "BACKEND_INTERNAL_URL=${BACKEND_PUBLIC_URL}" \
    -t "${IMAGE}" \
    --push \
    .
