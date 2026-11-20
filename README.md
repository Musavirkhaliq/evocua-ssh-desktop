# EvoCUA SSH Desktop

Run a Linux desktop in your browser through an SSH tunnel. EvoCUA SSH Desktop starts an Openbox desktop with a file manager, application menu, and terminal. The viewer supports keyboard and mouse input, plain-text clipboard sharing, audio playback, and microphone forwarding.

It runs independently of the EvoCUA model code. The host runs Linux and the client can use a browser on Linux, macOS, or Windows.

## Install on a Linux host

The commands below are for Ubuntu 24.04. Other Linux distributions need equivalent packages and a compatible noVNC installation.

```bash
sudo apt update
sudo apt install git openssh-server xvfb openbox x11vnc novnc websockify x11-utils xauth \
  dbus-x11 dbus-user-session pulseaudio-utils nautilus xterm curl \
  python3-gi gir1.2-gtk-3.0 gir1.2-wnck-3.0
```

Run the application as a regular user. It needs a user D-Bus session and a reachable PulseAudio or PipeWire-Pulse server. On a headless Ubuntu host without either audio server, install `pipewire-audio` and run `systemctl --user start pipewire-pulse.socket wireplumber.service` as that user. The SSH server must allow local port forwarding.

## Connect over SSH

On the Linux host, clone and start the desktop:

```bash
git clone https://github.com/Musavirkhaliq/evocua-ssh-desktop.git
cd evocua-ssh-desktop
./evocua-desktop doctor
./evocua-desktop start
```

On your client machine, keep this SSH tunnel open:

```bash
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:6080:127.0.0.1:6080 USER@HOST
```

Open [the desktop viewer](http://localhost:6080/) in a browser on your client. If you also cloned the repository on the client, `./evocua-desktop tunnel USER@HOST` runs the same SSH command. You can also use VS Code Remote SSH port forwarding.

The HTTP and VNC listeners bind to the host's loopback interface. The SSH tunnel authenticates the client and encrypts the connection. The desktop endpoints themselves have no login and are reachable by other processes on the host. Use a trusted single-user host and avoid publishing either port.

## Use the desktop

- **Files** opens the host’s filesystem with the desktop user’s permissions. **Applications** opens installed apps. The bottom panel also shows open windows and workspaces.
- **Enable audio** forwards desktop playback. **Enable microphone** asks the browser for permission. In the Linux app, select **EvoCUA-Browser-Microphone** as the input. Browser microphone access requires localhost or HTTPS.
- Plain-text clipboard sync is enabled by default. Use **Ctrl+C** and **Ctrl+V** in the viewer, or **Cmd+C** and **Cmd+V** on macOS. Highlighting text leaves the viewer computer’s clipboard untouched. You can disable sync in the sidebar. In the **Clipboard** panel, **Copy to this computer** copies the displayed text to the computer running the viewer. **Send to desktop** sends typed or pasted text to the remote clipboard. Open the viewer in a browser on the computer where you want to paste. If the browser blocks automatic writes, copy the selected text from the panel. Clipboard access requires localhost or HTTPS. Text can include Unicode and is limited to 1 MiB per transfer.
- **Capture keyboard** uses fullscreen keyboard lock when available. **Send shortcut** provides common combinations when the client intercepts a keystroke. Some operating-system shortcuts stay local.
- From a shell, use `./evocua-desktop run APP [ARGS...]` to launch in the EvoCUA desktop’s private D-Bus session. If an app already has a running instance on a different desktop, quit it before relaunching. Snap apps launch in their normal confined scopes. Their private mount namespace can limit access to EvoCUA’s D-Bus portal, so upload dialogs may use toolkit fallbacks.

Check the viewer with `./evocua-desktop status`. Stop the browser and VNC endpoints with `./evocua-desktop stop`. The virtual desktop and open apps stay running, so `start` can reconnect to them.

## Run a second instance or change ports

Use the same settings in the shell that runs the start, stop, and app launcher commands. Pick a free display and free ports:

```bash
export EVOCUA_DISPLAY=:98
export EVOCUA_VNC_PORT=15998
export EVOCUA_WEB_PORT=16098
./evocua-desktop start
```

| Variable | Default |
| --- | --- |
| `EVOCUA_DISPLAY` | `:99` |
| `EVOCUA_VNC_PORT` | `5900` |
| `EVOCUA_WEB_PORT` | `6080` |
| `EVOCUA_RESOLUTION` | `1920x1080x24` for newly created displays |
| `EVOCUA_WEB_ROOT` | `/usr/share/novnc` |
| `EVOCUA_XAUTHORITY` | The per-display X authority file in the state directory |

Logs and generated X authority files go under `${XDG_STATE_HOME:-$HOME/.local/state}/evocua/novnc`. Browser profiles, credentials, and host logs are outside this directory.

## License

This project is available under the [MIT License](LICENSE). noVNC and the other host packages are installed separately under their own licenses.
