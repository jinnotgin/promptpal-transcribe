/**
 * Composable for capturing microphone audio as 16 kHz mono Float32 PCM.
 * Uses getUserMedia + AudioWorkletNode for low-latency, off-main-thread capture.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 * @param {(pcm: Float32Array) => void} onPcmChunk - called with each ~128ms PCM chunk
 * @param {{ onEnded?: () => void }} [options]
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
      }
    };

    analyser.connect(workletNode);

    store.isListening = true;
    store.isPaused = false;
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

    stopAudioGraph({ updateStore: false });
    activeDeviceId = nextDeviceId;
    await setupStream(nextStream);
    if (wasPaused) pause();
  }

  function pause() {
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = false;
    }
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

  function stopAudioGraph({ updateStore }) {
    stopLevelMetering();

    if (workletNode) {
      workletNode.port.postMessage({ type: "stop" });
      workletNode.disconnect();
      workletNode = null;
    }
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

  function interrupt() {
    stopAudioGraph({ updateStore: false });
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

  return { start, pause, resume, stop, switchDevice, interrupt };
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
