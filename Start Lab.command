#!/bin/bash
set -e
set -m

cd -P -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

state=.lab/launcher
mkdir -p .lab
if ! mkdir "$state" 2>/dev/null; then
  printf '%s\n' 'The lab launcher already has a session. Use Stop Lab.command first.'
  exit 1
fi

exec > >(/usr/bin/tee .lab/launcher.log) 2>&1
printf '%s\n' 'Starting Workflow Lab…'

if ! /bin/cat compose.yaml >/dev/null; then
  printf '%s\n' 'Cannot read compose.yaml. If the project is in Documents, allow Terminal to access the Documents Folder in System Settings → Privacy & Security → Files and Folders.' >&2
  rmdir "$state"
  exit 1
fi

children=()
compose_started=false
cleanup() {
  trap '' INT TERM HUP
  for pid in "${children[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || true
  done
  for pid in "${children[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  if "$compose_started"; then
    if ! docker compose stop postgres temporal; then
      printf '%s\n' 'Could not stop the containers. Run make stop-db stop-temporal once Docker is ready.'
    fi
  fi
  rm -f "$state/stop"
  rmdir "$state"
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

check_stop() {
  if [[ -f "$state/stop" ]]; then
    exit 0
  fi
}

wait_for() {
  local label="$1" seconds="$2"
  shift 2
  for ((attempt = 0; attempt < seconds; attempt++)); do
    check_stop
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  printf 'Timed out waiting for %s.\n' "$label" >&2
  return 1
}

for tool in docker go node npm curl make; do
  command -v "$tool" >/dev/null || { printf 'Install %s before starting the lab.\n' "$tool" >&2; exit 1; }
done
for port in 8080 "${TS_API_PORT:-8081}" 5173; do
  if /usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is in use. Stop the existing server before using this shortcut.\n' "$port" >&2
    exit 1
  fi
done

if ! docker info >/dev/null 2>&1; then
  /usr/bin/open -g -a Docker
  wait_for Docker 90 docker info
fi

ollama_url="${OLLAMA_URL:-http://127.0.0.1:11434}"
if ! curl -fsS --max-time 2 "${ollama_url%/}/api/tags" >/dev/null; then
  /usr/bin/open -g -a Ollama
  wait_for Ollama 45 curl -fsS --max-time 2 "${ollama_url%/}/api/tags"
fi

if [[ ! -x node_modules/.bin/vite ]] || ! (cd apps/api-ts && node -e 'require.resolve("@temporalio/worker")') >/dev/null 2>&1; then
  make install
fi
check_stop
compose_started=true
docker compose up -d --wait --wait-timeout 90 postgres temporal
check_stop

make dev-api &
children+=("$!")
make dev-worker &
children+=("$!")
make dev-api-ts &
children+=("$!")
make dev-worker-ts &
children+=("$!")
make dev-web &
children+=("$!")

web_url=http://127.0.0.1:5173
wait_for 'the web app' 60 curl -fsS --max-time 2 "$web_url/"
wait_for 'the Go API through the web app' 60 curl -fsS --max-time 2 "$web_url/api/health"
wait_for 'the TypeScript API through the web app' 60 curl -fsS --max-time 2 "$web_url/typescript/api/health"
if ! /usr/bin/open -b com.google.Chrome "$web_url/"; then
  printf 'Could not open Chrome automatically. Open %s/ in Chrome.\n' "$web_url" >&2
fi
printf 'Lab is running at %s/. Use Stop Lab.command or press Control+C here.\n' "$web_url"

while true; do
  check_stop
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' 'A lab process exited. See its output above.' >&2
      exit 1
    fi
  done
  sleep 1
done
