#!/bin/bash
set -e

cd -P -- "$(dirname -- "$0")"
state=.lab/launcher
if [[ ! -d "$state" ]]; then
  printf '%s\n' 'The lab launcher is already stopped.'
  exit 0
fi

touch "$state/stop"
printf '%s\n' 'Stopping the lab. Container volumes will be retained.'
for ((attempt = 0; attempt < 120; attempt++)); do
  if [[ ! -d "$state" ]]; then
    printf '%s\n' 'Lab launcher stopped.'
    exit 0
  fi
  sleep 1
done
printf '%s\n' 'The launcher is still busy. Check the Start Lab terminal for details.' >&2
exit 1
