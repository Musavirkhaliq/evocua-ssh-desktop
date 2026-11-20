
function addDesktopControls() {
    const toolbar = document.getElementById('noVNC_control_bar');
    const root = document.documentElement;
    const status = document.createElement('output');
    status.setAttribute('aria-live', 'polite');
    status.style.maxWidth = '12em';
    status.style.color = 'white';

    function addButton(label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'noVNC_button';
        button.textContent = label;
        toolbar.append(button);
        return button;
    }

    const microphone = addButton('Enable microphone');
    microphone.setAttribute('aria-pressed', 'false');
    const captureKeys = addButton('Capture keyboard');

    const shortcuts = {
        'Alt+Tab': [[KeyTable.XK_Alt_L, 'AltLeft'], [KeyTable.XK_Tab, 'Tab']],
        'Alt+F4': [[KeyTable.XK_Alt_L, 'AltLeft'], [KeyTable.XK_F4, 'F4']],
        'Alt+Space': [[KeyTable.XK_Alt_L, 'AltLeft'], [KeyTable.XK_space, 'Space']],
        'Super': [[KeyTable.XK_Super_L, 'MetaLeft']],
        'Ctrl+Tab': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_Tab, 'Tab']],
        'Ctrl+Shift+Tab': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_Shift_L, 'ShiftLeft'], [KeyTable.XK_Tab, 'Tab']],
        'Ctrl+N': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_n, 'KeyN']],
        'Ctrl+O': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_o, 'KeyO']],
        'Ctrl+Shift+N': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_Shift_L, 'ShiftLeft'], [KeyTable.XK_n, 'KeyN']],
        'Ctrl+W': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_w, 'KeyW']],
        'Ctrl+Shift+T': [[KeyTable.XK_Control_L, 'ControlLeft'], [KeyTable.XK_Shift_L, 'ShiftLeft'], [KeyTable.XK_t, 'KeyT']],
    };
    const shortcutMenu = document.createElement('select');
    shortcutMenu.setAttribute('aria-label', 'Send desktop shortcut');
    shortcutMenu.append(new Option('Send shortcut…', ''));
    for (const name of Object.keys(shortcuts)) shortcutMenu.append(new Option(name, name));
    toolbar.append(shortcutMenu, status);

    shortcutMenu.addEventListener('change', () => {
        const keys = shortcuts[shortcutMenu.value];
        shortcutMenu.selectedIndex = 0;
        if (!keys || !UI.connected) return;
        UI.rfb.focus();
        for (const [keysym, code] of keys) UI.rfb.sendKey(keysym, code, true);
        for (const [keysym, code] of keys.slice().reverse()) UI.rfb.sendKey(keysym, code, false);
    });

    captureKeys.addEventListener('click', async () => {
        if (!navigator.keyboard?.lock) {
            status.textContent = 'Use Send shortcut for keys reserved by this browser.';
            return;
        }
        try {
            if (!document.fullscreenElement) await root.requestFullscreen();
            await navigator.keyboard.lock();
            status.textContent = 'Keyboard captured. Hold Esc to release.';
            UI.rfb.focus();
        } catch {
            status.textContent = 'Keyboard capture was unavailable. Use Send shortcut.';
        }
    });
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) {
            navigator.keyboard?.unlock();
            if (status.textContent.startsWith('Keyboard captured')) status.textContent = '';
        }
    });

    let mic;
    function stopMic(message = '') {
        const previous = mic;
        mic = undefined;
        previous?.stream?.getTracks().forEach(track => track.stop());
        previous?.socket?.close();
        previous?.context?.close().catch(() => {});
        microphone.textContent = 'Enable microphone';
        microphone.setAttribute('aria-pressed', 'false');
        status.textContent = message;
    }

    microphone.addEventListener('click', async () => {
        if (mic) {
            stopMic();
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            status.textContent = 'Microphone access requires HTTPS or localhost.';
            return;
        }

        const session = {};
        mic = session;
        microphone.textContent = 'Cancel microphone';
        status.textContent = '';
        try {
            const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
            session.context = context;
            const resume = context.resume();
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
            if (mic !== session) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            session.stream = stream;
            await resume;
            await context.audioWorklet.addModule('microphone-worklet.js');
            if (mic !== session) return;

            const url = new URL('desktop-microphone', window.location.href);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(url);
            session.socket = socket;
            socket.onclose = event => {
                if (mic === session) stopMic(event.reason || 'Microphone connection closed.');
            };
            socket.onopen = () => {
                if (mic !== session) return;
                const worklet = new AudioWorkletNode(context, 'desktop-microphone', { outputChannelCount: [1] });
                worklet.port.onmessage = ({ data }) => {
                    if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 19200) socket.send(data);
                };
                context.createMediaStreamSource(stream).connect(worklet);
                // The worklet output is silent. Connecting it keeps the graph running.
                worklet.connect(context.destination);
                microphone.textContent = 'Stop microphone';
                microphone.setAttribute('aria-pressed', 'true');
                status.textContent = 'Select EvoCUA-Browser-Microphone in the remote app.';
                stream.getTracks().forEach(track => track.addEventListener('ended', () => {
                    if (mic === session) stopMic('Microphone access ended.');
                }));
            };
        } catch (error) {
            if (mic === session) {
                stopMic(error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Microphone unavailable.');
            }
        }
    });

    function syncControls() {
        const disconnected = !root.classList.contains('noVNC_connected');
        microphone.disabled = captureKeys.disabled = shortcutMenu.disabled = disconnected;
        if (disconnected) {
            navigator.keyboard?.unlock();
            if (mic) stopMic();
        }
    }

    new MutationObserver(syncControls).observe(root, { attributes: true, attributeFilter: ['class'] });
    syncControls();
    window.addEventListener('pagehide', () => {
        navigator.keyboard?.unlock();
        if (mic) stopMic();
    });
}

addDesktopControls();
