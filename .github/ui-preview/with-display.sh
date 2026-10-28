#!/usr/bin/env bash
# Starts a window manager and a compositor on the display xvfb-run created, then
# runs the command. Without a compositor a transparent window has undefined
# corners, and without a window manager two windows overlap at 0,0.
set -euo pipefail

if [ -z "${DISPLAY:-}" ]; then
    echo "DISPLAY is not set; run this under xvfb-run" >&2
    exit 1
fi

readonly DESKTOP_COLOUR="${UI_PREVIEW_DESKTOP_COLOUR:-#d9d4c8}"
readonly DESKTOP_IMAGE="$(mktemp --suffix=.png)"

openbox --sm-disable >/tmp/openbox.log 2>&1 &
openbox_pid=$!

# picom composites the root from _XROOTPMAP_ID. feh publishes that property,
# while xsetroot alone leaves this Xvfb root black.
read -r display_width display_height < <(xdotool getdisplaygeometry)
convert -size "${display_width}x${display_height}" "xc:${DESKTOP_COLOUR}" "$DESKTOP_IMAGE"
feh --no-fehbg --bg-fill "$DESKTOP_IMAGE"

# The app's Linux window is transparent, so the compositor owns the shadow.
# Match the 8px CSS shell radius so the shadow follows the visible edge instead
# of the square native window bounds.
picom \
    --backend xrender \
    --config /dev/null \
    --shadow \
    --shadow-radius=18 \
    --shadow-opacity=0.35 \
    --shadow-offset-x=0 \
    --shadow-offset-y=6 \
    --corner-radius=8 \
    >/tmp/picom.log 2>&1 &
picom_pid=$!

cleanup() {
    kill "$picom_pid" "$openbox_pid" 2>/dev/null || true
    rm -f "$DESKTOP_IMAGE"
}
trap cleanup EXIT

sleep 1
exec "$@"
