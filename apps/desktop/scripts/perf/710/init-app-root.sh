#!/usr/bin/env bash
set -euo pipefail

binary="$1"
app_root="$2"
timeout_seconds="${3:-120}"
database="$app_root/data/touchai.db"

mkdir -p "$app_root"
rm -f "$database" "$database-wal" "$database-shm"

"$binary" &
app_pid=$!

cleanup() {
    if kill -0 "$app_pid" 2>/dev/null; then
        kill -TERM "$app_pid" 2>/dev/null || true
        for _ in $(seq 1 50); do
            if ! kill -0 "$app_pid" 2>/dev/null; then
                break
            fi
            sleep 0.1
        done
        if kill -0 "$app_pid" 2>/dev/null; then
            kill -KILL "$app_pid" 2>/dev/null || true
        fi
    fi
    wait "$app_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 $((timeout_seconds * 5))); do
    if [[ -s "$database" ]]; then
        sleep 1
        exit 0
    fi
    sleep 0.2
done

echo "Timed out waiting for the initialized database at $database" >&2
exit 1
