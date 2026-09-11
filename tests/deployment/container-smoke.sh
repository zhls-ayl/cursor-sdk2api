#!/usr/bin/env bash
# Verify the actual runtime image with an empty account pool and no upstream access.
set -euo pipefail

smoke_image=${1:-cursor-sdk2api:local}
smoke_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
smoke_name="cursor-sdk2api-smoke-$$-$RANDOM"
smoke_container=
smoke_probe=
smoke_volume=
smoke_network=

cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$smoke_probe" ]]; then
    docker rm -f "$smoke_probe" >/dev/null || result=1
  fi
  if [[ -n "$smoke_container" ]]; then
    docker rm -f "$smoke_container" >/dev/null || result=1
  fi
  if [[ -n "$smoke_volume" ]]; then
    docker volume rm "$smoke_volume" >/dev/null || result=1
  fi
  if [[ -n "$smoke_network" ]]; then
    docker network rm "$smoke_network" >/dev/null || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker info >/dev/null
docker image inspect "$smoke_image" >/dev/null
smoke_network=$(docker network create --internal "${smoke_name}-network")
smoke_volume=$(docker volume create "${smoke_name}-state")
smoke_container=$(docker create \
  --network "$smoke_network" --network-alias gateway \
  --mount "type=volume,source=$smoke_volume,target=/data" \
  -e AUTH_MODE=managed \
  -e GATEWAY_ACCESS_KEY=container-smoke-synthetic-key \
  -e HOST=0.0.0.0 -e PORT=8080 -e STATE_DIR=/data \
  "$smoke_image")
docker start "$smoke_container" >/dev/null

docker exec -i "$smoke_container" /nodejs/bin/node --input-type=module - local \
  < "$smoke_dir/container-probe.mjs"
smoke_probe=$(docker create -i --network "$smoke_network" \
  --mount type=tmpfs,target=/data \
  --entrypoint /nodejs/bin/node "$smoke_image" --input-type=module - external)
docker start -ai "$smoke_probe" < "$smoke_dir/container-probe.mjs"
smoke_probe_exit=$(docker inspect --format '{{.State.ExitCode}}' "$smoke_probe")
if [[ "$smoke_probe_exit" != 0 ]]; then
  printf 'External production image probe failed: %s\n' "$smoke_probe_exit" >&2
  exit 1
fi

docker stop --time 10 "$smoke_container" >/dev/null
smoke_exit=$(docker inspect --format '{{.State.ExitCode}}' "$smoke_container")
if [[ "$smoke_exit" != 0 ]]; then
  printf 'Idle SIGTERM did not exit cleanly: %s\n' "$smoke_exit" >&2
  exit 1
fi
printf 'Production image smoke passed, including idle SIGTERM.\n'
