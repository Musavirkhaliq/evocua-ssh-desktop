
function addClipboardSync() {
    const container = document.getElementById('noVNC_container');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'noVNC_button';
    button.textContent = 'Enable clipboard sync';
    button.setAttribute('aria-pressed', 'false');
    const clipboardButton = document.getElementById('noVNC_clipboard_button');
    clipboardButton.after(button);
    const panel = document.getElementById('noVNC_clipboard');
    const field = document.getElementById('noVNC_clipboard_text');
    const status = document.createElement('div');
    status.setAttribute('role', 'status');

    function panelButton(label, action) {
        const control = document.createElement('button');
        control.type = 'button';
        control.className = 'noVNC_submit';
        control.textContent = label;
        control.addEventListener('click', action);
        panel.append(control);
    }

    panelButton('Copy to this computer', async () => {
        if (!field.value) await refresh(true);
        if (!field.value) {
            status.textContent = 'The desktop clipboard has no text.';
            return;
        }
        const text = field.value;
        if (await writeToComputer(text)) {
            status.textContent = 'Copied to this computer.';
            return;
        }
        field.focus();
        field.select();
        status.textContent = document.execCommand('copy')
            ? 'Copied to this computer.'
            : 'Press Ctrl+C or Cmd+C to copy the selected text.';
    });
    panelButton('Send to desktop', async () => {
        try {
            await sendText(field.value);
            status.textContent = 'Ready to paste on the desktop.';
        } catch {
            status.textContent = 'Could not send text to the desktop.';
        }
    });
    panel.append(status);
    // The stock noVNC handlers use legacy 8-bit CutText. The panel uses
    // the X11 clipboard bridge so it can preserve Unicode in both directions.
    field.addEventListener('input', () => { hasDraft = true; });
    field.addEventListener('change', event => event.stopImmediatePropagation(), true);
    document.getElementById('noVNC_clipboard_clear_button').addEventListener('click', event => {
        event.stopImmediatePropagation();
        field.value = '';
        hasDraft = false;
        status.textContent = '';
    }, true);

    let enabled = false;
    let previous;
    let pendingPaste;
    let copying = false;
    let hasDraft = false;
    let fetching = false;
    let generation = 0;
    const endpoint = 'desktop-clipboard';

    async function writeToComputer(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }

    async function refresh(force = false) {
        const panelOpen = panel.classList.contains('noVNC_open');
        if (!UI.connected || pendingPaste || copying || !document.hasFocus()) return;
        if (fetching || (!force && !enabled && !panelOpen)) return;
        fetching = true;
        const requestGeneration = generation;
        try {
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (!response.ok) return;
            const text = await response.json();
            if (pendingPaste || copying || requestGeneration !== generation || !document.hasFocus()) return;
            const changed = previous !== undefined && text !== previous;
            if ((force || panelOpen || changed) && !hasDraft && document.activeElement !== field) field.value = text ?? '';
            previous = text;
        } catch {
            // Retry after reconnecting.
        } finally {
            fetching = false;
        }
    }

    async function sendText(text) {
        generation++;
        const response = await fetch(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: text,
        });
        if (!response.ok) throw new Error('Clipboard upload failed');
        previous = text;
        hasDraft = false;
        field.value = text;
    }

    clipboardButton.addEventListener('click', () => {
        queueMicrotask(() => {
            if (panel.classList.contains('noVNC_open')) refresh(true);
        });
    });
    UI.clipboardReceive = () => refresh(true);
    async function readAfterCopy(oldText) {
        let text;
        // A remote application updates X11 only after receiving Ctrl+C.
        for (const delay of [80, 120, 240]) {
            await new Promise(resolve => window.setTimeout(resolve, delay));
            const response = await fetch(endpoint, { cache: 'no-store' });
            if (!response.ok) throw new Error('Desktop clipboard unavailable');
            text = await response.json();
            if (typeof text === 'string' && text !== oldText) return text;
        }
        if (typeof text !== 'string') throw new Error('No desktop text to copy');
        return text;
    }

    async function copyShortcut() {
        if (copying) return;
        copying = true;
        generation++;
        const text = readAfterCopy(previous);
        // Request the browser write during the trusted keystroke. The
        // ClipboardItem can resolve once the remote app provides its text.
        let browserWrite;
        try {
            if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
                browserWrite = navigator.clipboard.write([
                    new ClipboardItem({ 'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })) }),
                ]).then(() => true, () => false);
            }
        } catch {
            // Older browsers may only implement writeText.
        }
        try {
            const value = await text;
            if (!hasDraft) field.value = value;
            previous = value;
            const copied = await browserWrite || await writeToComputer(value);
            status.textContent = copied
                ? 'Copied to this computer.'
                : 'Click Copy to this computer to finish copying.';
        } catch {
            status.textContent = 'The desktop clipboard has no text.';
        } finally {
            copying = false;
        }
    }

    function forwardCopy(event, shift = false) {
        if (copying) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        UI.rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', true);
        if (shift) UI.rfb.sendKey(KeyTable.XK_Shift_L, 'ShiftLeft', true);
        UI.rfb.sendKey(KeyTable.XK_c, 'KeyC');
        if (shift) UI.rfb.sendKey(KeyTable.XK_Shift_L, 'ShiftLeft', false);
        UI.rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false);
        copyShortcut();
    }

    window.addEventListener('keydown', event => {
        if (!enabled || !UI.connected || !container.contains(event.target) ||
            event.key.toLowerCase() !== 'c' || !(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
        forwardCopy(event, event.shiftKey);
    }, true);

    window.addEventListener('copy', event => {
        if (enabled && UI.connected && container.contains(document.activeElement)) forwardCopy(event);
    }, true);

    function sendPaste(shift) {
        if (!UI.connected) return;
        UI.rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', true);
        if (shift) UI.rfb.sendKey(KeyTable.XK_Shift_L, 'ShiftLeft', true);
        UI.rfb.sendKey(KeyTable.XK_v, 'KeyV');
        if (shift) UI.rfb.sendKey(KeyTable.XK_Shift_L, 'ShiftLeft', false);
        UI.rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false);
    }

    async function paste(pending, text) {
        if (pending !== pendingPaste || pending.sent) return;
        pending.sent = true;
        generation++;
        try {
            if (typeof text === 'string') await sendText(text);
            button.title = text === undefined ? 'Browser clipboard access was blocked. You can still paste remote text.' : '';
            if (pending === pendingPaste && enabled) sendPaste(pending.shift);
        } catch {
            button.title = 'Could not send text to the desktop clipboard.';
        } finally {
            if (pending === pendingPaste) pendingPaste = undefined;
        }
    }

    window.addEventListener('keydown', event => {
        if (!enabled || !UI.connected || !container.contains(event.target) ||
            event.key.toLowerCase() !== 'v' || !(event.ctrlKey || event.metaKey) || event.altKey) return;

        // Allow the browser's real paste gesture, while holding the remote
        // keystroke until the clipboard server has acknowledged the text.
        event.stopImmediatePropagation();
        if (event.repeat) {
            event.preventDefault();
            return;
        }
        const pending = { shift: event.shiftKey };
        pendingPaste = pending;
        window.setTimeout(async () => {
            if (pending !== pendingPaste || pending.sent) return;
            let text;
            try {
                text = await navigator.clipboard.readText();
            } catch {
                // Preserve access to the existing remote clipboard.
            }
            paste(pending, text);
        }, 120);
    }, true);

    window.addEventListener('paste', event => {
        if (!enabled || !UI.connected || (!pendingPaste && !container.contains(event.target))) return;
        event.preventDefault();
        const pending = pendingPaste ?? { shift: false };
        pendingPaste = pending;
        paste(pending, event.clipboardData?.getData('text/plain'));
    }, true);

    // On refocus, establish a new baseline so reopening the tab cannot
    // overwrite text just copied in another local application.
    window.addEventListener('blur', () => {
        generation++;
        previous = undefined;
    });
    button.disabled = !navigator.clipboard;
    if (button.disabled) button.title = 'Clipboard access requires HTTPS or localhost.';
    function setEnabled(value) {
        enabled = value;
        generation++;
        previous = undefined;
        pendingPaste = undefined;
        button.textContent = enabled ? 'Disable clipboard sync' : 'Enable clipboard sync';
        button.setAttribute('aria-pressed', String(enabled));
        if (enabled) {
            button.title = '';
            refresh();
        }
    }

    const preference = 'evocua:clipboard-sync';
    if (!button.disabled && sessionStorage.getItem(preference) !== 'disabled') setEnabled(true);
    button.addEventListener('click', () => {
        setEnabled(!enabled);
        sessionStorage.setItem(preference, enabled ? 'enabled' : 'disabled');
        UI.rfb?.focus();
    });
    window.setInterval(refresh, 500);
}

addClipboardSync();
