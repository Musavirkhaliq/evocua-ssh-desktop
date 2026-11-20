#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
    echo "Usage: $0 APPLICATION [ARGUMENT ...]" >&2
    exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/novnc/session.sh"
export XDG_CURRENT_DESKTOP=Openbox
export XDG_SESSION_TYPE=x11
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11

panel=$(xprop -root -f _EVOCUA_PANEL 32x _EVOCUA_PANEL 2>/dev/null)
if [[ ! $panel =~ (0x[0-9a-f]+)$ ]]; then
    echo "Start the EvoCUA desktop with ./start_novnc.sh first." >&2
    exit 1
fi
window=${BASH_REMATCH[1]}
if [[ $(xprop -id "$window" _NET_WM_NAME 2>/dev/null) != *'"EvoCUA Desktop Panel"' ]]; then
    echo "Start the EvoCUA desktop with ./start_novnc.sh first." >&2
    exit 1
fi
panel_pid=$(xprop -id "$window" _NET_WM_PID)
if [[ ! $panel_pid =~ =\ ([0-9]+)$ ]]; then
    echo "Could not locate the EvoCUA desktop session." >&2
    exit 1
fi

# Reuse the panel's session bus so native dialogs stay on EvoCUA's display.
address=$(tr '\0' '\n' <"/proc/${BASH_REMATCH[1]}/environ" |
    sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')
if [[ -z $address ]]; then
    echo "The EvoCUA desktop session bus is unavailable." >&2
    exit 1
fi
export DBUS_SESSION_BUS_ADDRESS="$address"
exec /usr/bin/python3 "$script_dir/novnc/desktop_launch.py" "$@"
