import { defineStore } from "pinia";
import {
  SYSTEM_DEFAULT_MIC_ID,
  createSystemDefaultMic,
} from "@/features/transcription/composables/useMicrophoneDevices.js";

/**
 * @typedef {'auto' | 'webgpu' | 'wasm'} ExecutionEnv
 * @typedef {'idle' | 'checking-cache' | 'downloading-model' | 'loading-model' | 'downloading-diarization-model' | 'loading-diarization-model' | 'transcoding' | 'vad' | 'transcribing' | 'diarizing' | 'complete' | 'error'} ProcessPhase
 * @typedef {import('@/features/transcription/lib/transcriptionDb').TranscriptSegment} TranscriptSegment
 */

const STORAGE_KEY_ENV = "transcription-env";

export const useTranscriptionStore = defineStore("transcription", {
  state: () => ({
    // --- Settings (persisted to localStorage) ---
    /** @type {ExecutionEnv} */
    executionEnv: parseExecutionEnv(localStorage.getItem(STORAGE_KEY_ENV)),
    enableDiarization: true,

    // --- Runtime detection ---
    webgpuAvailable: false,
    /** @type {'webgpu' | 'wasm' | null} */
    detectedRuntime: null,
    /** @type {'fp16' | 'int8' | null} */
    detectedModelVersion: null,
    runtimeReason: "",
    /** @type {import('@/features/transcription/lib/hardwareCapabilities').RuntimeAdvisory} */
    runtimeAdvisory: "none",

    // --- File ---
    /** @type {File | null} */
    file: null,
    fileName: "",
    fileSize: 0,
    /** @type {number | null} */
    fileDuration: null,
    /** @type {string | null} */
    audioUrl: null,
    /** @type {number[]} Compact normalized waveform envelope. */
    waveformSamples: [],

    // --- Pipeline ---
    /** @type {ProcessPhase} */
    processPhase: "idle",
    isCancelled: false,

    // --- Live microphone mode ---
    liveMode: false,
    isListening: false,
    isPaused: false,
    micLevel: 0,
    selectedMicId: SYSTEM_DEFAULT_MIC_ID,
    selectedMicLabel: "System default",
    selectedMicAvailable: true,
    availableMics: [createSystemDefaultMic()],
    micInputState: "ready",
    micInputError: null,
    /** @type {number | null} Elapsed seconds since live session started */
    liveElapsed: null,

    // --- Progress (0-100 per phase) ---
    transcriptionProgress: 0,
    diarizationProgress: 0,

    // --- Model state ---
    parakeetCached: false,
    sortformerCached: false,
    parakeetLoadProgress: 0,
    parakeetLoadIndeterminate: false,
    sortformerLoadProgress: 0,

    // --- Results ---
    /** @type {TranscriptSegment[]} */
    segments: [],
    /** @type {Record<string, string>} speakerId → display name */
    speakerNames: {},
    /** @type {Record<string, string>} speakerId → hex color */
    speakerColors: {},
    /** Manually-added speaker ids that may not be referenced by any segment yet. */
    /** @type {string[]} */
    addedSpeakerIds: [],

    // --- Error ---
    /** @type {{ code: string, message: string, recoverable: boolean } | null} */
    error: null,
  }),

  getters: {
    isProcessing(state) {
      return (
        state.processPhase !== "idle" &&
        state.processPhase !== "complete" &&
        state.processPhase !== "error"
      );
    },

    /** @returns {'webgpu' | 'wasm'} */
    effectiveRuntime(state) {
      if (state.executionEnv === "webgpu") {
        return state.webgpuAvailable ? "webgpu" : "wasm";
      }
      if (state.executionEnv === "wasm") return "wasm";
      return state.webgpuAvailable ? "webgpu" : "wasm";
    },

    /** @returns {TranscriptSegment[]} */
    displaySegments(state) {
      return state.segments.map((seg) => ({
        ...seg,
        speaker: seg.speaker
          ? (state.speakerNames[seg.speaker] ?? seg.speaker)
          : seg.speaker,
      }));
    },

    /**
     * Canonical list of speaker ids (from segments + manually added),
     * preserving insertion order.
     * @returns {string[]}
     */
    speakerList(state) {
      /** @type {string[]} */
      const ids = [];
      const seen = new Set();
      for (const segment of state.segments) {
        if (segment.speaker && !seen.has(segment.speaker)) {
          seen.add(segment.speaker);
          ids.push(segment.speaker);
        }
      }
      for (const id of state.addedSpeakerIds) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      return ids;
    },
  },

  actions: {
    /**
     * @param {File} file
     */
    setFile(file) {
      this.file = file;
      this.fileName = file.name;
      this.fileSize = file.size;
      this.fileDuration = null;
      this.enableDiarization = true;
      this.error = null;
      this.segments = [];
      this.speakerNames = {};
      this.speakerColors = {};
      this.addedSpeakerIds = [];
      this.processPhase = "idle";
      this.waveformSamples = [];
    },

    clearFile() {
      if (this.audioUrl) {
        URL.revokeObjectURL(this.audioUrl);
      }
      this.file = null;
      this.fileName = "";
      this.fileSize = 0;
      this.fileDuration = null;
      this.audioUrl = null;
      this.waveformSamples = [];
      this.segments = [];
      this.speakerNames = {};
      this.speakerColors = {};
      this.addedSpeakerIds = [];
      this.clearLiveState();
      this.clearProcessingState();
    },

    clearProcessingState() {
      this.processPhase = "idle";
      this.isCancelled = false;
      this.transcriptionProgress = 0;
      this.diarizationProgress = 0;
      this.error = null;
    },

    /**
     * @param {'transcription' | 'diarization'} phase
     * @param {number} value 0-100
     */
    updateProgress(phase, value) {
      const key = `${phase}Progress`;
      if (key in this) {
        this[key] = value;
      }
    },

    /**
     * @param {import('@/features/transcription/lib/hardwareCapabilities').HardwareCapability} capability
     */
    setHardwareCapability(capability) {
      this.webgpuAvailable = capability.backend === "webgpu";
      this.detectedRuntime = capability.backend;
      this.detectedModelVersion = capability.version;
      this.runtimeReason = capability.reason;
      this.runtimeAdvisory = capability.advisory;
    },

    /** @param {TranscriptSegment[]} segs */
    setSegments(segs) {
      this.segments = segs;
    },

    /** @param {string} speakerId @param {string} newName */
    renameSpeaker(speakerId, newName) {
      this.speakerNames[speakerId] = newName;
    },

    /** @param {string} speakerId @param {string} color */
    setSpeakerColor(speakerId, color) {
      this.speakerColors[speakerId] = color;
    },

    /**
     * Register a new speaker id. The id is generated by the caller so the
     * segment-assignment dropdown can use a freshly-created speaker
     * immediately. Returns the id.
     * @param {string} [displayName]
     * @returns {string}
     */
    addSpeaker(displayName) {
      const id = nextSpeakerId(this.speakerList);
      if (!this.addedSpeakerIds.includes(id)) {
        this.addedSpeakerIds.push(id);
      }
      if (displayName) this.speakerNames[id] = displayName;
      return id;
    },

    /**
     * Remove a speaker id. Segments that referenced it become unassigned
     * (`null`) so the user can reassign them. The display name mapping is
     * cleared.
     * @param {string} speakerId
     */
    removeSpeaker(speakerId) {
      if (this.speakerList.length <= 1) return;
      this.addedSpeakerIds = this.addedSpeakerIds.filter(
        (id) => id !== speakerId,
      );
      delete this.speakerNames[speakerId];
      delete this.speakerColors[speakerId];
      this.segments = this.segments.map((segment) =>
        segment.speaker === speakerId ? { ...segment, speaker: null } : segment,
      );
    },

    /**
     * @param {string} segmentId
     * @param {string | null} speakerId
     */
    assignSegmentSpeaker(segmentId, speakerId) {
      this.segments = this.segments.map((segment) =>
        segment.id === segmentId ? { ...segment, speaker: speakerId } : segment,
      );
      if (speakerId) {
        this.addedSpeakerIds = this.addedSpeakerIds.filter(
          (id) => id !== speakerId,
        );
      }
    },

    /** @param {ExecutionEnv} env */
    setExecutionEnv(env) {
      this.executionEnv = env;
      localStorage.setItem(STORAGE_KEY_ENV, env);
    },

    /** @param {boolean} enabled */
    setEnableDiarization(enabled) {
      this.enableDiarization = enabled;
    },

    /** @param {boolean} mode */
    setLiveMode(mode) {
      this.liveMode = mode;
    },

    clearLiveState() {
      this.isListening = false;
      this.isPaused = false;
      this.micLevel = 0;
      this.liveElapsed = null;
      this.micInputState = this.selectedMicAvailable ? "ready" : "unavailable";
      this.micInputError = null;
    },

    /**
     * @param {{
     *   availableMics: Array<{ deviceId: string, label: string, available: boolean, isSystemDefault: boolean }>,
     *   selectedMicId: string,
     *   selectedMicLabel: string,
     *   selectedMicAvailable: boolean,
     * }} payload
     */
    setMicrophoneDevices(payload) {
      this.availableMics = payload.availableMics;
      this.selectedMicId = payload.selectedMicId;
      this.selectedMicLabel = payload.selectedMicLabel;
      this.selectedMicAvailable = payload.selectedMicAvailable;
      if (!payload.selectedMicAvailable && this.micInputState === "ready") {
        this.micInputState =
          this.isListening && !this.isPaused ? "interrupted" : "unavailable";
      }
      if (
        payload.selectedMicAvailable &&
        this.micInputState === "unavailable"
      ) {
        this.micInputState = "ready";
      }
    },

    /**
     * @param {string | null} deviceId
     */
    selectMicrophone(deviceId) {
      const nextId = deviceId || SYSTEM_DEFAULT_MIC_ID;
      const mic = this.availableMics.find(
        (candidate) => candidate.deviceId === nextId,
      );
      this.selectedMicId = nextId;
      this.selectedMicLabel =
        mic?.label ||
        (nextId === SYSTEM_DEFAULT_MIC_ID
          ? "System default"
          : "Selected microphone");
      this.selectedMicAvailable = mic?.available !== false;
      this.micInputState = this.selectedMicAvailable ? "ready" : "unavailable";
      this.micInputError = null;
    },

    /**
     * @param {'ready' | 'switching' | 'interrupted' | 'unavailable'} state
     */
    setMicInputState(state) {
      this.micInputState = state;
    },

    /**
     * @param {{ code: string, message: string, recoverable: boolean } | null} error
     */
    setMicInputError(error) {
      this.micInputError = error;
    },
  },
});

/**
 * @typedef {ReturnType<typeof useTranscriptionStore>} TranscriptionStore
 */

/**
 * @param {string | null} value
 * @returns {ExecutionEnv}
 */
function parseExecutionEnv(value) {
  return value === "webgpu" || value === "wasm" || value === "auto"
    ? value
    : "auto";
}

/**
 * Generate a fresh "Speaker N" id that doesn't collide with the existing
 * speaker set. Diarization emits ids like "Speaker 1", "Speaker 2" etc., so we
 * keep the same naming.
 * @param {string[]} existing
 * @returns {string}
 */
function nextSpeakerId(existing) {
  const used = new Set(existing);
  for (let i = 1; i <= existing.length + 1; i += 1) {
    const candidate = `Speaker ${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `Speaker ${existing.length + 1}`;
}
