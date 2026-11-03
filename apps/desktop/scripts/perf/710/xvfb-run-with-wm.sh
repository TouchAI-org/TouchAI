#!/usr/bin/env bash
set -euo pipefail

for command in dbus-run-session dbus-send dunst openbox wmctrl xvfb-run; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "$command is required for the RFC 710 performance display." >&2
        exit 1
    fi
done

# The single-quoted body must expand inside the DBus session, not in this shell.
# shellcheck disable=SC2016
exec /usr/bin/xvfb-run -a -s "-screen 0 1280x1024x24 -nolisten tcp" \
    dbus-run-session -- bash -c '
        set -euo pipefail

        runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/touchai-perf-runtime.XXXXXX")"
        chmod 700 "$runtime_dir"
        export XDG_RUNTIME_DIR="$runtime_dir"

        display_log_dir="${TOUCHAI_PERF_RUN_LOG_DIR:-$runtime_dir/display}"
        created_display_log_dir=0
        if [[ ! -d "$display_log_dir" ]]; then
            mkdir -p "$display_log_dir"
            created_display_log_dir=1
        fi

        cleanup() {
            local status=$?
            for pid in "${dunst_pid:-}" "${wm_pid:-}"; do
                if [[ -n "$pid" ]]; then
                    kill "$pid" 2>/dev/null || true
                fi
            done
            for pid in "${dunst_pid:-}" "${wm_pid:-}"; do
                if [[ -n "$pid" ]]; then
                    wait "$pid" 2>/dev/null || true
                fi
            done
            if [[ "$created_display_log_dir" -eq 1 ]]; then
                rm -rf "$display_log_dir"
            fi
            rm -rf "$runtime_dir"
            exit "$status"
        }
        trap cleanup EXIT INT TERM HUP

        openbox >"$display_log_dir/openbox.log" 2>&1 &
        wm_pid=$!

        dunst >"$display_log_dir/dunst.log" 2>&1 &
        dunst_pid=$!

        wm_ready=0
        notification_ready=0
        for _ in $(seq 1 100); do
            if [[ "$wm_ready" -eq 0 ]] && kill -0 "$wm_pid" 2>/dev/null && wmctrl -m >/dev/null 2>&1; then
                wm_ready=1
            fi
            if [[ "$notification_ready" -eq 0 ]] && kill -0 "$dunst_pid" 2>/dev/null; then
                session_names="$(dbus-send --session --print-reply=literal \
                    --dest=org.freedesktop.DBus \
                    /org/freedesktop/DBus \
                    org.freedesktop.DBus.ListNames 2>/dev/null || true)"
                if grep -Fq "org.freedesktop.Notifications" <<<"$session_names" &&
                    dbus-send --session --print-reply=literal \
                        --dest=org.freedesktop.Notifications \
                        /org/freedesktop/Notifications \
                        org.freedesktop.Notifications.GetServerInformation >/dev/null 2>&1; then
                    notification_ready=1
                fi
            fi
            if [[ "$wm_ready" -eq 1 && "$notification_ready" -eq 1 ]]; then
                break
            fi
            sleep 0.1
        done

        if [[ "$wm_ready" -ne 1 ]]; then
            echo "Openbox did not become ready on DISPLAY=$DISPLAY." >&2
            cat "$display_log_dir/openbox.log" >&2
            exit 1
        fi
        if [[ "$notification_ready" -ne 1 ]]; then
            echo "Dunst did not register org.freedesktop.Notifications." >&2
            cat "$display_log_dir/dunst.log" >&2
            exit 1
        fi

        "$@"
    ' _ "$@"
