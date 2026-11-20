# Shared configuration for the desktop launcher and app wrapper.
export DISPLAY="${EVOCUA_DISPLAY:-:99}"
if [[ ! $DISPLAY =~ ^:[0-9]+$ ]]; then
    echo 'EVOCUA_DISPLAY must be a local X11 display such as :99.' >&2
    exit 2
fi

display_number=${DISPLAY#:}
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export PULSE_SINK="evocua_display_$display_number"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/evocua/novnc"
export XAUTHORITY="${EVOCUA_XAUTHORITY:-$state_dir/Xauthority-$display_number}"
