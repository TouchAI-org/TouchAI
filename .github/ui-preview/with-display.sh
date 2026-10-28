#!/usr/bin/env bash
# Starts a window manager and a compositor on the display xvfb-run created, then
# runs the command. Without a compositor a transparent window has undefined
# corners, and without a window manager two windows overlap at 0,0.
set -euo pipefail

if [ -z "${DISPLAY:-}" ]; then
    echo "DISPLAY is not set; run this under xvfb-run" >&2
    exit 1
fi

# Keep this in sync with DESKTOP_COLOUR in lib/capture.mjs.
xsetroot -solid '#000000'

openbox --sm-disable >/tmp/openbox.log 2>&1 &
openbox_pid=$!

picom --backend xrender --config /dev/null >/tmp/picom.log 2>&1 &
picom_pid=$!

cleanup() {
    kill "$picom_pid" "$openbox_pid" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
exec "$@"
