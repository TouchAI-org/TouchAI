#!/usr/bin/env bash
set -euo pipefail

binary="$1"
app_root="$2"
timeout_seconds="${3:-120}"
ready_query="${4:-}"
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

stable_migration_count=""
stable_ready_polls=0
for _ in $(seq 1 $((timeout_seconds * 5))); do
    if [[ -s "$database" ]]; then
        if [[ -z "$ready_query" ]]; then
            integrity="$(sqlite3 "$database" 'PRAGMA quick_check;' 2>/dev/null || true)"
            migration_count="$(
                sqlite3 "$database" 'SELECT COUNT(*) FROM migrations;' 2>/dev/null || true
            )"
            if [[ "$integrity" == "ok" && "$migration_count" =~ ^[1-9][0-9]*$ ]]; then
                if [[ "$migration_count" == "$stable_migration_count" ]]; then
                    stable_ready_polls=$((stable_ready_polls + 1))
                    if (( stable_ready_polls >= 2 )); then
                        exit 0
                    fi
                else
                    stable_migration_count="$migration_count"
                    stable_ready_polls=0
                fi
            else
                stable_migration_count=""
                stable_ready_polls=0
            fi
            sleep 0.2
            continue
        fi
        if [[ "$(sqlite3 "$database" "$ready_query" 2>/dev/null || true)" == "1" ]]; then
            # Let the writing transaction finish before the app is terminated.
            sleep 0.2
            exit 0
        fi
    fi
    sleep 0.2
done

echo "Timed out waiting for the initialized database at $database (ready query: $ready_query)" >&2
exit 1
