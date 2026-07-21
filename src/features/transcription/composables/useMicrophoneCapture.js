/**
 * Composable for capturing microphone audio as 16 kHz mono Float32 PCM.
 * Uses getUserMedia + AudioWorkletNode for low-latency, off-main-thread capture.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 * @param {(pcm: Float32Array) => void} onPcmChunk - called with each ~128ms PCM chunk
 * @param {{ onEnded?: () => void, onStreamReady?: (stream: MediaStream) => void }} [options]
 */
export function useMicrophoneCapture(store, onPcmChunk, options = {}) {
  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {MediaStream | null} */
  let stream = null;
  /** @type {AudioWorkletNode | null} */
  let workletNode = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  let sourceNode = null;
  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {number | null} */
  let levelRafId = null;
  let flushSequence = 0;
  /** @type {Map<number, { resolve: () => void, reject: (reason?: unknown) => void }>} */
  const pendingFlushes = new Map();

  let activeDeviceId = null;

  async function start(startOptions = {}) {
    activeDeviceId = startOptions.deviceId || null;
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: createAudioConstraints(activeDeviceId),
      });
      await setupStream(nextStream);
    } catch (err) {
      const denied =
        err.name === "NotAllowedError" || err.name === "PermissionDeniedError";
      throw new Error(denied ? "MIC_PERMISSION_DENIED" : "MIC_UNAVAILABLE");
    }
  }

  async function setupStream(nextStream) {
    stream = nextStream;
    for (const track of stream.getAudioTracks()) {
      track.addEventListener?.("ended", handleTrackEnded, { once: true });
    }

    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule("/pcm-capture-processor.js");

    sourceNode = audioCtx.createMediaStreamSource(stream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    sourceNode.connect(analyser);

    workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor");
    workletNode.port.onmessage = (e) => {
      if (e.data.type === "pcm") {
        onPcmChunk(new Float32Array(e.data.pcm));
      } else if (e.data.type === "flushed") {
        const pending = pendingFlushes.get(e.data.requestId);
        if (pending) {
          pendingFlushes.delete(e.data.requestId);
          pending.resolve();
        }
      }
    };

    analyser.connect(workletNode);

    store.isListening = true;
    store.isPaused = false;
    options.onStreamReady?.(stream);
    startLevelMetering();
  }

  async function switchDevice(switchOptions = {}) {
    const wasPaused = Boolean(store.isPaused);
    const nextDeviceId = switchOptions.deviceId || null;
    let nextStream;
    try {
      nextStream = await navigator.mediaDevices.getUserMedia({
        audio: createAudioConstraints(nextDeviceId),
      });
    } catch (err) {
      const denied =
        err.name === "NotAllowedError" || err.name === "PermissionDeniedError";
      throw new Error(denied ? "MIC_PERMISSION_DENIED" : "MIC_UNAVAILABLE");
    }

    await flushAndStop({ updateStore: false });
    activeDeviceId = nextDeviceId;
    await setupStream(nextStream);
    if (wasPaused) await pause();
  }

  async function pause() {
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = false;
    }
    await flushWorklet("flush");
    store.isPaused = true;
    store.micLevel = 0;
  }

  function resume() {
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
    }
    store.isPaused = false;
  }

  function stop() {
    stopAudioGraph({ updateStore: true });
  }

  async function flushAndStop(options = {}) {
    const updateStore = options.updateStore ?? true;
    await flushWorklet("flush-and-stop");
    stopAudioGraph({ updateStore, notifyWorklet: false });
  }

  async function flushWorklet(type) {
    const node = workletNode;
    if (!node) return;
    const requestId = ++flushSequence;
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingFlushes.delete(requestId);
        reject(new Error("Microphone PCM flush timed out"));
      }, 2000);
      pendingFlushes.set(requestId, {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject,
      });
      node.port.postMessage({ type, requestId });
    });
  }

  function stopAudioGraph({ updateStore, notifyWorklet = true }) {
    stopLevelMetering();

    if (workletNode) {
      if (notifyWorklet) workletNode.port.postMessage({ type: "stop" });
      workletNode.disconnect();
      workletNode = null;
    }
    for (const pending of pendingFlushes.values()) {
      pending.reject(
        new DOMException("Microphone capture stopped", "AbortError"),
      );
    }
    pendingFlushes.clear();
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (analyser) {
      analyser.disconnect();
      analyser = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }

    if (updateStore) {
      store.isListening = false;
      store.isPaused = false;
      store.micLevel = 0;
    }
  }

  async function interrupt() {
    await flushAndStop({ updateStore: false });
    store.micLevel = 0;
  }

  function handleTrackEnded() {
    options.onEnded?.();
  }

  function startLevelMetering() {
    if (!analyser) return;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!analyser) return;
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      store.micLevel = sum / buf.length / 255;
      levelRafId = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopLevelMetering() {
    if (levelRafId != null) {
      cancelAnimationFrame(levelRafId);
      levelRafId = null;
    }
  }

  function getStream() {
    return stream;
  }

  return {
    start,
    pause,
    resume,
    stop,
    flushAndStop,
    switchDevice,
    interrupt,
    getStream,
  };
}

function createAudioConstraints(deviceId) {
  const constraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}
