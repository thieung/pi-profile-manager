#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUTHORING_SOURCE="${PI_PROFILE_MANAGER_AUTHORING_SOURCE:-/Users/thieunv/projects/thieunv-space/fb-subsribers/scripts/pi-profile-manager}"

if [[ ! -f "$AUTHORING_SOURCE" ]]; then
  printf 'SKIP: authoring source not available: %s\n' "$AUTHORING_SOURCE"
  exit 0
fi

cmp -s "$AUTHORING_SOURCE" "$REPO_ROOT/payload/pi-profile-manager" || {
  printf 'ERROR: packaged payload differs from authoring source: %s\n' "$AUTHORING_SOURCE" >&2
  exit 1
}

printf 'PASS: packaged payload matches authoring source\n'
