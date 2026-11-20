#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
script_dir=$PWD
source "$script_dir/novnc/session.sh"
export LIBGL_ALWAYS_SOFTWARE=1

resolution="${EVOCUA_RESOLUTION:-1920x1080x24}"
vnc_port="${EVOCUA_VNC_PORT:-5900}"
web_port="${EVOCUA_WEB_PORT:-6080}"
web_root="${EVOCUA_WEB_ROOT:-/usr/share/novnc}"

for port in "$vnc_port" "$web_port"; do
    if [[ ! $port =~ ^[1-9][0-9]{0,4}$ ]] || (( port > 65535 )); then
        echo "Desktop ports must be between 1 and 65535: $port" >&2
        exit 2
    fi
done
if [[ $vnc_port == "$web_port" ]]; then
    echo "The VNC and web ports must differ." >&2
    exit 2
fi

check_dependencies() {
    local cmd failed=0
    for cmd in Xvfb openbox-session x11vnc xdpyinfo xprop xauth dbus-run-session pactl parec pacat curl setsid flock nautilus xterm; do
        if ! command -v "$cmd" >/dev/null; then
            echo "Missing dependency: $cmd" >&2
            failed=1
        fi
    done
    if [[ ! -r "$web_root/vnc.html" ]] || ! /usr/bin/python3 -c 'import websockify' 2>/dev/null; then
        echo "Install the noVNC assets and system websockify package." >&2
        failed=1
    fi
    if ! /usr/bin/python3 -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("Wnck", "3.0")' 2>/dev/null; then
        echo "Install PyGObject and the GTK 3 and libwnck introspection packages." >&2
        failed=1
    fi
    if ! pactl info >/dev/null 2>&1; then
        echo "Start a PulseAudio or PipeWire-Pulse server for this user." >&2
        failed=1
    fi
    return "$failed"
}

if [[ ${1:-} == --doctor ]]; then
    check_dependencies
    echo "Linux desktop dependencies and audio server are ready."
    exit
fi

umask 077
mkdir -p -- "$state_dir"
exec 9>"$state_dir/launcher-$display_number.lock"
flock 9

# Match complete commands owned by this account, including the old launcher.
service_pids() {
    local expected="$*"
    local process
    while read -r process; do
        [[ $(ps -p "$process" -o args=) == "$expected" ]] && printf '%s\n' "$process"
    done < <(pgrep -u "$(id -u)" -f -- "$2" || true)
    return 0
}

stop_processes() {
    local pid i
    while read -r pid; do
        kill "$pid" 2>/dev/null || continue
        for ((i=0; i<50; i++)); do
            kill -0 "$pid" 2>/dev/null || break
            [[ $(ps -p "$pid" -o stat=) == Z* ]] && break
            sleep 0.1
        done
    done
}

legacy_web=(/usr/bin/python3 /usr/bin/websockify "--web=$web_root" "127.0.0.1:$web_port" "127.0.0.1:$vnc_port")
vnc=(x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport "$vnc_port")
managed_server() {
    pgrep -u "$(id -u)" -af 'novnc/server.py' |
        awk -v prefix="/usr/bin/python3 $script_dir/novnc/server.py $web_port $vnc_port $web_root $PULSE_SINK " '
            { pid = $1; sub(/^[0-9]+ +/, ""); if (index($0, prefix) == 1) print pid }'
}

if [[ ${1:-} == --stop ]]; then
    stop_processes < <(managed_server)
    stop_processes < <(service_pids "${legacy_web[@]}")
    stop_processes < <(service_pids "${vnc[@]}")
    echo "Browser access stopped. The virtual desktop and open windows are still running."
    exit
fi

check_dependencies

wait_for() {
    local component=$1 log=$2
    shift 2
    for ((i=0; i<80; i++)); do
        "$@" && return
        sleep 0.1
    done
    echo "$component failed to start. See $state_dir/$log-$display_number.log" >&2
    tail -20 "$state_dir/$log-$display_number.log" >&2 || true
    exit 1
}

display_ready() { xdpyinfo >/dev/null 2>&1; }
wm_ready() {
    local id
    id=$(xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null) || return 1
    [[ $id =~ window\ id\ \#\ (0x[0-9a-f]+)$ ]] || return 1
    id=${BASH_REMATCH[1]}
    [[ $(xprop -id "$id" _NET_SUPPORTING_WM_CHECK 2>/dev/null) == *"window id # $id" ]]
}
panel_ready() {
    local panel
    panel=$(xprop -root -f _EVOCUA_PANEL 32x _EVOCUA_PANEL 2>/dev/null) || return 1
    [[ $panel =~ (0x[0-9a-f]+)$ ]] || return 1
    [[ $(xprop -id "${BASH_REMATCH[1]}" _NET_WM_NAME 2>/dev/null) == *'"EvoCUA Desktop Panel"' ]]
}

vnc_ready() {
    local banner
    exec 7<>"/dev/tcp/127.0.0.1/$vnc_port" || return 1
    IFS= read -r -t 1 banner <&7 || banner=
    exec 7>&-
    [[ $banner == "RFB "* ]]
} 2>/dev/null
web_ready() {
    [[ $(curl -fsS --max-time 1 "http://127.0.0.1:$web_port/healthz" 2>/dev/null) == "evocua-desktop-4 $DISPLAY" ]]
}

if ! display_ready; then
    if [[ -S /tmp/.X11-unix/X$display_number ]]; then
        echo "Display $DISPLAY is running but inaccessible. Check EVOCUA_XAUTHORITY." >&2
        exit 1
    fi
    touch "$XAUTHORITY"
    chmod 600 "$XAUTHORITY"
    xauth add "$DISPLAY" MIT-MAGIC-COOKIE-1 "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    setsid nohup Xvfb "$DISPLAY" -screen 0 "$resolution" -auth "$XAUTHORITY" -nolisten tcp \
        -noreset </dev/null >"$state_dir/xvfb-$display_number.log" 2>&1 9>&- &
    wait_for "X display" xvfb display_ready
fi

# PipeWire removes its automatic fallback as soon as a named sink exists.
# Keep uncategorized host audio away from the desktop monitor on headless hosts.
host_sink=$(pactl get-default-sink)
if [[ $host_sink == auto_null || $host_sink == evocua_display_* ]]; then
    host_sink=$(pactl list short sinks |
        awk '$2 !~ /^evocua_display_/ && $2 != "auto_null" {print $2; exit}')
    if [[ -z $host_sink ]]; then
        host_sink=evocua_host_fallback
        pactl load-module module-null-sink "sink_name=$host_sink" \
            'sink_properties=device.description=Headless-Host-Output' >/dev/null
    fi
    pactl set-default-sink "$host_sink"
fi
sink_index=$(pactl list short sinks | awk -v name="$PULSE_SINK" '$2 == name {print $1}')
if [[ -z $sink_index ]]; then
    pactl load-module module-null-sink "sink_name=$PULSE_SINK" \
        'sink_properties=device.description=EvoCUA-Virtual-Desktop' >/dev/null
    sink_index=$(pactl list short sinks | awk -v name="$PULSE_SINK" '$2 == name {print $1}')
    [[ -n $sink_index ]] || { echo "Could not create the EvoCUA audio sink." >&2; exit 1; }
fi

mic_sink="${PULSE_SINK}_mic"
mic_source="${PULSE_SINK}_microphone"
if ! pactl list short sinks | awk -v name="$mic_sink" '$2 == name {found=1} END {exit !found}'; then
    pactl load-module module-null-sink "sink_name=$mic_sink" channels=1 \
        'sink_properties=device.description=EvoCUA-Microphone-Input' >/dev/null
fi
if ! pactl list short sources | awk -v name="$mic_source" '$2 == name {found=1} END {exit !found}'; then
    pactl load-module module-remap-source "master=$mic_sink.monitor" "source_name=$mic_source" channels=1 \
        'source_properties=device.description=EvoCUA-Browser-Microphone' >/dev/null
fi

if ! wm_ready; then
    setsid nohup dbus-run-session -- openbox-session </dev/null >"$state_dir/openbox-$display_number.log" 2>&1 9>&- &
    wait_for "Window manager on $DISPLAY" openbox wm_ready
fi

if ! panel_ready; then
    setsid nohup env GDK_BACKEND=x11 XDG_CURRENT_DESKTOP=Openbox \
        dbus-run-session -- /usr/bin/python3 "$script_dir/novnc/desktop_panel.py" \
        </dev/null >"$state_dir/panel-$display_number.log" 2>&1 9>&- &
    wait_for "Desktop panel on $DISPLAY" panel panel_ready
fi

if [[ -z $(service_pids "${vnc[@]}") ]]; then
    if vnc_ready; then
        echo "VNC port $vnc_port is already serving another desktop. Set EVOCUA_VNC_PORT to a free port." >&2
        exit 1
    fi
    setsid nohup "${vnc[@]}" </dev/null >"$state_dir/x11vnc-$display_number.log" 2>&1 9>&- &
fi
wait_for "VNC" x11vnc vnc_ready

if ! web_ready; then
    stop_processes < <(managed_server)
    stop_processes < <(service_pids "${legacy_web[@]}")
    setsid nohup /usr/bin/python3 "$script_dir/novnc/server.py" "$web_port" "$vnc_port" \
        "$web_root" "$PULSE_SINK" "$sink_index" </dev/null >"$state_dir/web-$display_number.log" 2>&1 9>&- &
    wait_for "Browser desktop" web web_ready
fi

echo "EvoCUA desktop ready on $DISPLAY."
echo "Forward port $web_port and open http://localhost:$web_port/vnc.html?autoconnect=1&resize=scale"
echo "Click Enable audio in the noVNC sidebar to hear the virtual desktop."
echo "For microphone input, enable it in the sidebar and select EvoCUA-Browser-Microphone in your desktop app."
echo "Logs: $state_dir"
