#!/bin/sh
set -eu

# Keep already downloaded, hash-verified archives when the mirror returns a transient HTTP error.
rm -f /etc/apt/apt.conf.d/docker-clean
for attempt in 1 2 3; do
  if apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends "$@"; then
    rm -rf /var/lib/apt/lists/*
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then sleep 2; fi
done
exit 1
