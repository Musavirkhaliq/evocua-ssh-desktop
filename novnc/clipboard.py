"""Keep ownership of the X11 clipboard and serve text over a private socket."""

import os
import socketserver
import sys
import threading

import gi

os.environ["GDK_BACKEND"] = "x11"
gi.require_version("Gdk", "3.0")
gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk


MAX_TEXT = 1024 * 1024


class ClipboardRequest(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(5)
        header = self.rfile.readline(32)
        ready = threading.Event()
        result = []

        def respond(text):
            result.append(text)
            ready.set()

        clipboard = self.server.clipboard
        if header == b"GET\n":
            GLib.idle_add(clipboard.request_text, lambda _, text, *args: respond(text))
        elif header.startswith(b"SET "):
            try:
                size = int(header[4:])
                if not 0 <= size <= MAX_TEXT:
                    return
                raw = self.rfile.read(size)
                if len(raw) != size:
                    return
                text = raw.decode("utf-8")
                if "\0" in text:
                    return
            except (ValueError, UnicodeError):
                return

            def set_text():
                clipboard.set_text(text, -1)
                respond("")
                return False

            GLib.idle_add(set_text)
        else:
            return

        if ready.wait(timeout=4):
            text = result[0]
            if text is None:
                self.wfile.write(b"-1\n")
                return
            data = text.encode("utf-8")
            if len(data) <= MAX_TEXT:
                self.wfile.write(f"{len(data)}\n".encode() + data)


if __name__ == "__main__":
    with socketserver.ThreadingUnixStreamServer(sys.argv[1], ClipboardRequest) as server:
        server.daemon_threads = True
        server.clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        Gtk.main()
