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
# Keep these arrays aligned. The launcher owns each worker process group.
worker_backends=(go typescript python)
worker_targets=(dev-worker dev-worker-ts dev-worker-py)
worker_pids=("" "" "")
worker_generations=(0 0 0)
worker_stopping=(false false false)

stop_group() {
  kill -TERM -- "-$1" 2>/dev/null || true
}

# Workers can stop or restart independently of the API and web processes.
supervise_workers() {
  local index backend pid key identity
  for index in "${!worker_backends[@]}"; do
    backend="${worker_backends[$index]}"
    pid="${worker_pids[$index]}"
    key="$state/worker-$backend"
    if [[ -n "$pid" ]] && ! kill -0 -- "-$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      worker_pids[$index]=""
      pid=""
      rm -f "$key.identity"
      if "${worker_stopping[$index]}"; then
        worker_stopping[$index]=false
        rm -f "$key.stopping"
      else
        rm -f "$key.run"
        touch "$key.failed"
        printf '%s worker exited. Restart it from Chat to try again.\n' "$backend"
      fi
    fi
    # A .run file expresses the requested state. The process group determines when shutdown is complete.
    if [[ -f "$key.run" ]]; then
      if [[ -z "$pid" ]]; then
        worker_generations[$index]=$((worker_generations[index] + 1))
        # A new identity lets the status check distinguish this worker from old pollers.
        identity="workflow-lab-$backend-$$-${worker_generations[$index]}"
        printf '%s\n' "$identity" > "$key.identity"
        rm -f "$key.failed"
        LAB_WORKER_IDENTITY="$identity" make "${worker_targets[$index]}" &
        worker_pids[$index]="$!"
      fi
    elif [[ -n "$pid" ]] && ! "${worker_stopping[$index]}"; then
      worker_stopping[$index]=true
      touch "$key.stopping"
      stop_group "$pid"
    fi
  done
}
compose_started=false
cleanup() {
  trap '' INT TERM HUP
  for pid in "${children[@]}" "${worker_pids[@]}"; do
    if [[ -n "$pid" ]]; then stop_group "$pid"; fi
  done
  for pid in "${children[@]}" "${worker_pids[@]}"; do
    if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null || true; fi
  done
  if "$compose_started"; then
    if ! docker compose stop postgres temporal; then
      printf '%s\n' 'Could not stop the containers. Run make stop-db stop-temporal once Docker is ready.'
    fi
  fi
  rm -f "$state/stop" "$state"/worker-*
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
for port in 8080 "${TS_API_PORT:-8081}" "${PY_API_PORT:-8082}" 5173; do
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
if ! apps/api-py/.venv/bin/python -c 'import mcp, temporalio, langgraph.checkpoint.postgres, fastapi' >/dev/null 2>&1; then
  make install-py
fi
check_stop
compose_started=true
docker compose up -d --wait --wait-timeout 90 postgres temporal
check_stop

make dev-api &
children+=("$!")
make dev-api-ts &
children+=("$!")
make dev-api-py &
children+=("$!")
for backend in "${worker_backends[@]}"; do
  touch "$state/worker-$backend.run"
done
supervise_workers
LAB_WORKER_CONTROL=1 make dev-web &
children+=("$!")

web_url=http://127.0.0.1:5173
wait_for 'the web app' 60 curl -fsS --max-time 2 "$web_url/"
wait_for 'the Go API through the web app' 60 curl -fsS --max-time 2 "$web_url/api/health"
wait_for 'the TypeScript API through the web app' 60 curl -fsS --max-time 2 "$web_url/typescript/api/health"
wait_for 'the Python API through the web app' 60 curl -fsS --max-time 2 "$web_url/python/api/health"
if ! /usr/bin/open -b com.google.Chrome "$web_url/"; then
  printf 'Could not open Chrome automatically. Open %s/ in Chrome.\n' "$web_url" >&2
fi
printf 'Lab is running at %s/. Use Stop Lab.command or press Control+C here.\n' "$web_url"

while true; do
  check_stop
  supervise_workers
  for pid in "${children[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '%s\n' 'A lab process exited. See its output above.' >&2
      exit 1
    fi
  done
  sleep 1
done
