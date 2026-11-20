"""Native X11 panel for the EvoCUA Openbox session."""

import subprocess
from pathlib import Path

import gi

from desktop_launch import snap_scope

gi.require_version("Gdk", "3.0")
gi.require_version("GdkX11", "3.0")
gi.require_version("Gtk", "3.0")
gi.require_version("Wnck", "3.0")

from gi.repository import Gdk, GdkX11, Gio, GLib, Gtk, Wnck


def show_error(parent, error):
    dialog = Gtk.MessageDialog(
        transient_for=parent, modal=True, message_type=Gtk.MessageType.ERROR,
        buttons=Gtk.ButtonsType.CLOSE, text="Could not open the application",
    )
    dialog.format_secondary_text(str(error))
    dialog.run()
    dialog.destroy()


def launch_menu_entry(application):
    prefix = snap_scope(application.get_executable())
    if prefix and isinstance(application, Gio.DesktopAppInfo):
        entry = GLib.KeyFile()
        entry.load_from_file(application.get_filename(), GLib.KeyFileFlags.NONE)
        command = entry.get_string("Desktop Entry", "Exec")
        entry.set_string("Desktop Entry", "Exec", " ".join(prefix) + " " + command)
        entry.set_boolean("Desktop Entry", "DBusActivatable", False)
        application = Gio.DesktopAppInfo.new_from_keyfile(entry)
    context = Gdk.Display.get_default().get_app_launch_context()
    application.launch([], context)


def main():
    panel = Gtk.Window(title="EvoCUA Desktop Panel")
    panel.set_decorated(False)
    panel.set_resizable(False)
    panel.set_accept_focus(False)
    panel.set_type_hint(Gdk.WindowTypeHint.DOCK)
    panel.stick()

    bar = Gtk.Box(spacing=8)
    bar.set_border_width(4)
    panel.add(bar)

    def launch(*command):
        try:
            launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE)
            launcher.set_cwd(str(Path.home()))
            launcher.spawnv(command)
        except GLib.Error as error:
            show_error(panel, error)

    def add_button(label, icon, action):
        button = Gtk.Button(label=label, image=Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.BUTTON))
        button.set_always_show_image(True)
        button.connect("clicked", lambda _: action())
        bar.pack_start(button, False, False, 0)
        return button

    add_button("Files", "system-file-manager", lambda: launch("nautilus", "--new-window", str(Path.home())))
    add_button("Terminal", "utilities-terminal", lambda: launch("xterm"))

    applications = Gtk.MenuButton(label="Applications")
    menu = Gtk.Menu()
    for app in sorted(Gio.AppInfo.get_all(), key=lambda item: item.get_display_name().casefold()):
        if not app.should_show():
            continue
        item = Gtk.MenuItem(label=app.get_display_name())

        def open_app(_, application=app):
            try:
                launch_menu_entry(application)
            except GLib.Error as error:
                show_error(panel, error)

        item.connect("activate", open_app)
        menu.append(item)
    menu.show_all()
    applications.set_popup(menu)
    bar.pack_start(applications, False, False, 0)

    handle = Wnck.Handle.new(Wnck.ClientType.PAGER)
    screen = handle.get_default_screen()
    tasks = Wnck.Tasklist.new_with_handle(handle)
    pager = Wnck.Pager.new_with_handle(handle)
    pager.set_display_mode(Wnck.PagerDisplayMode.NAME)
    bar.pack_start(tasks, True, True, 0)
    bar.pack_start(pager, False, False, 0)
    add_button(
        "Show Desktop", "user-desktop",
        lambda: screen.toggle_showing_desktop(not screen.get_showing_desktop()),
    )

    display = Gdk.Display.get_default()
    bounds = display.get_primary_monitor().get_geometry()
    panel.set_size_request(bounds.width, -1)
    panel.show_all()
    height = panel.get_allocated_height()
    panel.move(bounds.x, bounds.y + bounds.height - height)
    xid = GdkX11.X11Window.get_xid(panel.get_window())
    properties = [
        ("_NET_WM_STRUT", f"0, 0, 0, {height}"),
        ("_NET_WM_STRUT_PARTIAL", f"0, 0, 0, {height}, 0, 0, 0, 0, 0, 0, 0, {bounds.width - 1}"),
    ]
    for name, value in properties:
        subprocess.run(["xprop", "-id", str(xid), "-f", name, "32c", "-set", name, value], check=True)
    subprocess.run(
        ["xprop", "-root", "-f", "_EVOCUA_PANEL", "32x", "-set", "_EVOCUA_PANEL", str(xid)],
        check=True,
    )
    panel.connect("destroy", Gtk.main_quit)
    Gtk.main()


if __name__ == "__main__":
    main()
