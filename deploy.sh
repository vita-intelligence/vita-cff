#!/usr/bin/env bash
set -euo pipefail

# One-shot production deploy. Builds + pushes both Docker images,
# then triggers a re-pull on both Azure App Services so the new
# containers come up.
#
# Usage from the repo root:
#
#     ./deploy.sh                  # build + push + restart both apps
#     ./deploy.sh --skip-restart   # just push images (manual restart later)
#
# Override the Azure resource names via env if they ever change:
#
#     RESOURCE_GROUP=Vita_NPD \
#     BACKEND_APP=vita-npd-backend \
#     FRONTEND_APP=vita-npd-frontend \
#     ./deploy.sh

cd "$(dirname "$0")"

RESOURCE_GROUP="${RESOURCE_GROUP:-Vita_NPD}"
BACKEND_APP="${BACKEND_APP:-vita-npd-backend}"
FRONTEND_APP="${FRONTEND_APP:-vita-npd-frontend}"
BACKEND_IMAGE="${BACKEND_IMAGE:-maksymcherhyk/vita-npd-backend:latest}"

SKIP_RESTART=0
if [ "${1:-}" = "--skip-restart" ]; then
    SKIP_RESTART=1
fi

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

if ! docker info >/dev/null 2>&1; then
    echo "[error] docker daemon not reachable — open Docker Desktop and retry" >&2
    exit 1
fi

HAS_AZ=1
if ! command -v az >/dev/null 2>&1; then
    HAS_AZ=0
    echo "[warn ] az CLI not installed — will skip the App Service restarts" \
         "and print portal instructions instead."
fi

if [ "${HAS_AZ}" -eq 1 ] && [ "${SKIP_RESTART}" -eq 0 ]; then
    if ! az account show >/dev/null 2>&1; then
        echo "[warn ] az not logged in — running 'az login' interactively..."
        az login >/dev/null
    fi
fi

# ---------------------------------------------------------------------------
# Backend image
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo "[1/4] backend image: ${BACKEND_IMAGE}"
echo "============================================================"
(
    cd server
    docker buildx build \
        --platform linux/amd64 \
        --progress=plain \
        -t "${BACKEND_IMAGE}" \
        --push \
        .
)

# ---------------------------------------------------------------------------
# Frontend image (delegates to the existing client/build-and-push.sh
# so the BACKEND_PUBLIC_URL build-arg stays defined in one place)
# ---------------------------------------------------------------------------

echo
echo "============================================================"
echo "[2/4] frontend image (via client/build-and-push.sh)"
echo "============================================================"
(
    cd client
    ./build-and-push.sh
)

# ---------------------------------------------------------------------------
# Restart App Services so they pull the new images
# ---------------------------------------------------------------------------

if [ "${SKIP_RESTART}" -eq 1 ] || [ "${HAS_AZ}" -eq 0 ]; then
    echo
    echo "============================================================"
    echo "Restart skipped. To force-pull the new images manually:"
    echo "  Portal -> App Service -> Configuration -> Container settings"
    echo "  -> retype ':latest' on Image and tag -> Save"
    echo "Repeat for ${BACKEND_APP} and ${FRONTEND_APP}."
    echo "============================================================"
    exit 0
fi

echo
echo "============================================================"
echo "[3/4] restarting backend (${BACKEND_APP})"
echo "============================================================"
az webapp restart --name "${BACKEND_APP}" --resource-group "${RESOURCE_GROUP}"

echo
echo "============================================================"
echo "[4/4] restarting frontend (${FRONTEND_APP})"
echo "============================================================"
az webapp restart --name "${FRONTEND_APP}" --resource-group "${RESOURCE_GROUP}"

echo
echo "============================================================"
echo "Deploy complete. Tail the backend log stream to watch the"
echo "migrations run on container start:"
echo
echo "  az webapp log tail --name ${BACKEND_APP} \\"
echo "      --resource-group ${RESOURCE_GROUP}"
echo "============================================================"
