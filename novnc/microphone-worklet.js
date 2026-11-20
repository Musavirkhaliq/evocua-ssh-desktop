class DesktopMicrophone extends AudioWorkletProcessor {
    constructor() {
        super();
        this.packet = new ArrayBuffer(1920);
        this.view = new DataView(this.packet);
        this.offset = 0;
    }

    process(inputs) {
        for (const sample of inputs[0]?.[0] ?? []) {
            this.view.setInt16(this.offset, Math.max(-32768, Math.min(32767, sample * 32768)), true);
            this.offset += 2;
            if (this.offset === this.packet.byteLength) {
                this.port.postMessage(this.packet, [this.packet]);
                this.packet = new ArrayBuffer(1920);
                this.view = new DataView(this.packet);
                this.offset = 0;
            }
        }
        return true;
    }
}

registerProcessor('desktop-microphone', DesktopMicrophone);
