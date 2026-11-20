"""Serve the noVNC desktop and its PulseAudio monitor on the same port."""

import fcntl
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

from websockify.websocketproxy import ProxyRequestHandler, WebSocketProxy


MAX_CLIPBOARD = 1024 * 1024
ASSETS = Path(__file__).resolve().parent


class DesktopRequest(ProxyRequestHandler):
    def reject_cross_site(self):
        site = self.headers.get("Sec-Fetch-Site")
        origin = self.headers.get("Origin")
        different_origin = origin and urlsplit(origin).netloc != self.headers.get("Host")
        if site in {"cross-site", "same-site"} or (site is None and different_origin):
            self.send_error(403)
            return True
        return False

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/vnc.html", "/vnc_auto.html"):
            if path == "/":
                self.send_response(302)
                self.send_header("Location", "vnc.html?autoconnect=1&resize=scale")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            page = (Path(self.server.web) / "vnc.html").read_bytes()
            page = page.replace(b'src="app/ui.js"', b'src="app/ui.js?evocua=3"')
            page = page.replace(
                b'</body>', b'<script defer src="desktop-audio.js"></script></body>'
            )
            self.send_asset(page, "text/html; charset=utf-8")
        elif path == "/app/ui.js":
            ui = (Path(self.server.web) / "app/ui.js").read_bytes()
            ui = ui.replace(b"../core/rfb.js", b"../core/rfb.js?evocua=1")
            ui += (ASSETS / "controls.js").read_bytes()
            ui += (ASSETS / "clipboard.js").read_bytes()
            self.send_asset(ui, "text/javascript")
        elif path == "/core/rfb.js":
            client = (Path(self.server.web) / "core/rfb.js").read_bytes()
            # x11vnc advertises ExtendedClipboard through LibVNCServer, but
            # the X selection bridge only handles the classic CutText message.
            client = client.replace(b"encs.push(encodings.pseudoEncodingExtendedClipboard);", b"")
            self.send_asset(client, "text/javascript")
        elif path == "/desktop-audio.js":
            self.send_asset((ASSETS / "audio.js").read_bytes(), "text/javascript")
        elif path == "/microphone-worklet.js":
            self.send_asset((ASSETS / "microphone-worklet.js").read_bytes(), "text/javascript")
        elif path == "/desktop-clipboard":
            if not self.reject_cross_site():
                self.clipboard_request(b"GET\n")
        elif path in ("/healthz", "/desktop-audio", "/desktop-microphone"):
            if self.reject_cross_site():
                return
            if path == "/healthz":
                self.send_asset(f"evocua-desktop-4 {os.environ['DISPLAY']}\n".encode(), "text/plain")
            else:
                self.send_error(426, "WebSocket required")
        else:
            super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/desktop-clipboard":
            self.send_error(404)
            return
        if self.reject_cross_site():
            return
        if self.headers.get_content_type() != "text/plain":
            self.send_error(415)
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
            if not 0 <= size <= MAX_CLIPBOARD:
                self.send_error(413)
                return
            data = self.rfile.read(size)
            if len(data) != size or b"\0" in data:
                self.send_error(400)
                return
            data.decode("utf-8")
        except (ValueError, UnicodeError):
            self.send_error(400)
            return
        self.clipboard_request(f"SET {size}\n".encode() + data)

    def clipboard_request(self, message):
        try:
            with socket.socket(socket.AF_UNIX) as bridge:
                bridge.settimeout(5)
                bridge.connect(self.server.clipboard_path)
                bridge.sendall(message)
                with bridge.makefile("rb") as reply:
                    size = int(reply.readline(32))
                    data = reply.read(max(0, size))
                    if len(data) != max(0, size):
                        raise ValueError("Incomplete clipboard reply")
        except (OSError, ValueError):
            self.send_error(503, "Desktop clipboard unavailable")
            return
        self.send_asset(json.dumps(data.decode() if size >= 0 else None).encode(), "application/json")

    def send_asset(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def handle_upgrade(self):
        if not self.reject_cross_site():
            super().handle_upgrade()

    def new_websocket_client(self):
        path = urlsplit(self.path).path
        if path == "/desktop-microphone":
            self.receive_microphone()
            return
        if path != "/desktop-audio":
            super().new_websocket_client()
            return

        with subprocess.Popen(
            [
                "parec", "--device", self.server.sink + ".monitor", "--raw",
                "--format=s16le", "--rate=48000", "--channels=2",
                "--latency-msec=40",
            ],
            stdout=subprocess.PIPE,
        ) as capture:
            try:
                pending = False
                while True:
                    readers = [self.request]
                    if not pending:
                        readers.append(capture.stdout)
                    writers = [self.request] if pending else []
                    ready, writable, _ = select.select(readers, writers, [], 5)
                    if self.request in ready:
                        _, closed = self.recv_frames()
                        if closed:
                            return
                    if writable:
                        pending = self.send_frames()
                    if capture.stdout in ready:
                        pcm = os.read(capture.stdout.fileno(), 3840)
                        if not pcm:
                            raise self.CClose(1011, "Desktop audio capture stopped")
                        pending = self.send_frames([pcm])
                    if pending and not ready and not writable:
                        raise self.CClose(1011, "Desktop audio connection stalled")
            finally:
                capture.terminate()
                try:
                    capture.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    capture.kill()

    def receive_microphone(self):
        state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
        lock_path = state / "evocua" / "novnc" / (self.server.sink + ".mic.lock")
        with lock_path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise self.CClose(1008, "Microphone already in use")

            # This bridge is not desktop playback. Clear DISPLAY so the
            # desktop playback router never moves it to the speaker sink.
            environment = dict(os.environ)
            environment.pop("DISPLAY", None)
            with subprocess.Popen(
                [
                    "pacat", "--playback", "--device", self.server.sink + "_mic",
                    "--raw", "--format=s16le", "--rate=48000", "--channels=1",
                    "--latency-msec=40", "--client-name=EvoCUA-Browser-Microphone",
                ],
                stdin=subprocess.PIPE, env=environment,
            ) as playback:
                try:
                    fd = playback.stdin.fileno()
                    os.set_blocking(fd, False)
                    while playback.poll() is None:
                        ready, _, _ = select.select([self.request], [], [], 15)
                        if not ready:
                            raise self.CClose(1000, "Microphone stream idle")
                        frames, closed = self.recv_frames()
                        if closed:
                            return
                        for frame in frames:
                            if len(frame) != 1920:
                                raise self.CClose(1003, "Expected 20 ms of mono PCM")
                            try:
                                os.write(fd, frame)
                            except BlockingIOError:
                                pass  # Drop stale audio if playback falls behind.
                except BrokenPipeError:
                    raise self.CClose(1011, "Microphone sink unavailable")
                finally:
                    playback.terminate()
                    try:
                        playback.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        playback.kill()


class DesktopProxy(WebSocketProxy):
    def poll(self):
        super().poll()
        # Openbox and newly launched apps inherit PULSE_SINK. Route streams
        # from existing apps too, but leave other displays' streams alone.
        try:
            result = subprocess.check_output(
                ["pactl", "-f", "json", "list", "sink-inputs"], timeout=2
            )
            for stream in json.loads(result):
                if stream["sink"] == self.sink_index:
                    continue
                properties = stream["properties"]
                if properties.get("application.name") == "EvoCUA-Browser-Microphone":
                    continue
                display = properties.get("window.x11.display", "").encode()
                pid = properties.get("application.process.id", "")
                if pid.isdecimal():
                    try:
                        environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
                    except OSError:
                        environment = []
                    display = next(
                        (item[8:] for item in environment if item.startswith(b"DISPLAY=")),
                        display,
                    )
                if display.removesuffix(b".0") == os.environb[b"DISPLAY"]:
                    subprocess.run(
                        ["pactl", "move-sink-input", str(stream["index"]), self.sink],
                        check=False, timeout=2,
                    )
        except (subprocess.SubprocessError, ValueError) as error:
            self.logger.warning("Could not route desktop audio: %s", error)


if __name__ == "__main__":
    web_port, vnc_port, web_root, sink, sink_index = sys.argv[1:]
    server = DesktopProxy(
        DesktopRequest, listen_host="127.0.0.1", listen_port=int(web_port),
        target_host="127.0.0.1", target_port=int(vnc_port), web=web_root,
        file_only=True,
    )
    server.sink = sink
    server.sink_index = int(sink_index)
    with tempfile.TemporaryDirectory(prefix="evocua-clipboard-") as directory:
        server.clipboard_path = str(Path(directory) / "bridge.sock")
        with subprocess.Popen([sys.executable, str(ASSETS / "clipboard.py"), server.clipboard_path]) as clipboard:
            try:
                for _ in range(50):
                    if Path(server.clipboard_path).exists():
                        break
                    if clipboard.poll() is not None:
                        raise RuntimeError("Could not start the X11 clipboard bridge")
                    time.sleep(0.1)
                else:
                    raise RuntimeError("Timed out starting the X11 clipboard bridge")
                server.start_server()
            finally:
                clipboard.terminate()
