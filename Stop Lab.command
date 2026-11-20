#!/bin/bash
set -e

cd -P -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
state=.lab/launcher
stop_restate_container() {
  # Also handle containers left behind by an older or manually run launcher.
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    docker compose stop restate
  fi
}
if [[ ! -d "$state" ]]; then
  stop_restate_container
  printf '%s\n' 'The lab launcher is already stopped.'
  exit 0
fi

touch "$state/stop"
printf '%s\n' 'Stopping the lab. Container volumes will be retained.'
for ((attempt = 0; attempt < 120; attempt++)); do
  if [[ ! -d "$state" ]]; then
    stop_restate_container
    printf '%s\n' 'Lab launcher stopped.'
    exit 0
  fi
  sleep 1
done
printf '%s\n' 'The launcher is still busy. Check the Start Lab terminal for details.' >&2
exit 1
