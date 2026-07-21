/**
 * AudioWorklet processor that captures microphone input and downsamples
 * to 16 kHz mono Float32 PCM. Posts chunks to the main thread via port.
 *
 * Registration: audioWorklet.addModule('/pcm-capture-processor.js')
 * Node creation: new AudioWorkletNode(ctx, 'pcm-capture-processor')
 */

const TARGET_RATE = 16000;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._stopped = false;
    this._resampleBuffer = [];
    this._ratio = sampleRate / TARGET_RATE;
    this._srcIndex = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === "stop") this._stopped = true;
      if (e.data.type === "flush") {
        this._emitPcm();
        this.port.postMessage({ type: "flushed", requestId: e.data.requestId });
      }
      if (e.data.type === "flush-and-stop") {
        this._emitPcm();
        this._stopped = true;
        this.port.postMessage({ type: "flushed", requestId: e.data.requestId });
      }
    };
  }

  _emitPcm() {
    if (!this._resampleBuffer.length) return;
    const pcm = new Float32Array(this._resampleBuffer);
    this._resampleBuffer = [];
    this.port.postMessage({ type: "pcm", pcm }, [pcm.buffer]);
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0];
    if (!input || !input.length) return true;

    const mono = input[0];
    for (let i = 0; i < mono.length; i++) {
      this._srcIndex += 1;
      if (this._srcIndex >= this._ratio) {
        this._srcIndex -= this._ratio;
        this._resampleBuffer.push(mono[i]);
      }
    }

    if (this._resampleBuffer.length >= 2048) {
      this._emitPcm();
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
