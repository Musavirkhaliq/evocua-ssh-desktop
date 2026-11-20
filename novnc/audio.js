(() => {
    const toolbar = document.querySelector('#noVNC_control_bar');
    if (!toolbar) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'noVNC_button';
    button.textContent = 'Enable audio';
    button.setAttribute('aria-pressed', 'false');
    toolbar.querySelector('#noVNC_fullscreen_button').after(button);

    let context;
    let socket;
    let nextTime;

    function stop(label = 'Enable audio') {
        const activeSocket = socket;
        socket = undefined;
        activeSocket?.close();
        context?.close().catch(() => {});
        context = undefined;
        button.textContent = label;
        button.setAttribute('aria-pressed', 'false');
    }

    button.addEventListener('click', async () => {
        if (context) {
            stop();
            return;
        }

        try {
            const audio = new AudioContext({ latencyHint: 'interactive' });
            context = audio;
            await audio.resume();
            if (context !== audio) return;

            const url = new URL('desktop-audio', window.location.href);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const connection = new WebSocket(url);
            socket = connection;
            connection.binaryType = 'arraybuffer';
            nextTime = 0;
            button.textContent = 'Connecting audio…';

            connection.onopen = () => {
                if (socket !== connection) return;
                button.textContent = 'Mute audio';
                button.setAttribute('aria-pressed', 'true');
            };
            connection.onclose = () => {
                if (socket === connection) stop('Retry audio');
            };
            connection.onmessage = ({ data }) => {
                if (socket !== connection) return;
                const now = audio.currentTime;
                if (nextTime > now + 0.25) return;
                if (nextTime < now) nextTime = now + 0.06;

                const pcm = new DataView(data);
                const buffer = audio.createBuffer(2, pcm.byteLength / 4, 48000);
                const left = buffer.getChannelData(0);
                const right = buffer.getChannelData(1);
                for (let frame = 0; frame < buffer.length; frame++) {
                    left[frame] = pcm.getInt16(frame * 4, true) / 32768;
                    right[frame] = pcm.getInt16(frame * 4 + 2, true) / 32768;
                }
                const source = audio.createBufferSource();
                source.buffer = buffer;
                source.connect(audio.destination);
                source.start(nextTime);
                nextTime += buffer.duration;
            };
        } catch {
            stop('Retry audio');
        }
    });
    function syncConnection() {
        button.disabled = !document.documentElement.classList.contains('noVNC_connected');
        if (button.disabled && context) stop();
    }

    new MutationObserver(syncConnection).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class'],
    });
    syncConnection();
    window.addEventListener('pagehide', () => stop());
})();
