"""Launch Snap apps in their tracking scope while preserving the desktop bus."""

import os
import re
import shutil
import sys
import uuid


def snap_scope(executable):
    executable = shutil.which(executable) or executable
    match = re.fullmatch(r"/snap/bin/([a-z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?", executable)
    if not match:
        return []
    snap, app = match.groups()
    unit = f"snap.{snap}.{app or snap}-{uuid.uuid4()}.scope"
    return ["systemd-run", "--user", "--scope", "--quiet", "--unit=" + unit]


if __name__ == "__main__":
    command = sys.argv[1:]
    prefix = snap_scope(command[0])
    os.execvp((prefix or command)[0], prefix + command)
