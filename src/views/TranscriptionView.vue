<script setup>
import {
  ref,
  computed,
  inject,
  onMounted,
  onUnmounted,
  watch,
  nextTick,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import { saveAs } from "file-saver";
import {
  Bot,
  Check,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileAudio,
  Loader2,
  Mic,
  MicOff,
  MoreHorizontal,
  PanelRight,
  Search,
  Square,
  Trash2,
  Play,
  Pause,
  RefreshCw,
  RotateCcw,
  Plus,
  ShieldCheck,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ConfirmDestructiveButton from "@/components/ConfirmDestructiveButton.vue";
import { useTranscriptionStore } from "@/features/transcription/stores/transcriptionStore";
import { useRuntimeDetection } from "@/features/transcription/composables/useRuntimeDetection";
import { useModelManager } from "@/features/transcription/composables/useModelManager";
import { useTranscriptionPipeline } from "@/features/transcription/composables/useTranscriptionPipeline";
import { useTranscriptionExport } from "@/features/transcription/composables/useTranscriptionExport";
import { useTranscriptionHistory } from "@/features/transcription/composables/useTranscriptionHistory";
import { isChromeBrowser } from "@/features/transcription/lib/hardwareCapabilities.js";
import { APP_NAME } from "@/lib/config.js";
import { copyContent, formatDate } from "@/lib/utils.js";
import { trackAnalyticsEvent } from "@/lib/eventSignals.js";
import {
  formatPlainText,
  transcriptBaseName,
} from "@/features/transcription/lib/transcriptFormatters.js";
import { createWavBlobFromPcm } from "@/features/transcription/lib/audioUtils.js";
import TranscriptionDropZone from "@/features/transcription/components/TranscriptionDropZone.vue";
import TranscriptionHistoryList from "@/features/transcription/components/TranscriptionHistoryList.vue";
import TranscriptionSettingsPanel from "@/features/transcription/components/TranscriptionSettingsPanel.vue";
import TranscriptionProgressPanel from "@/features/transcription/components/TranscriptionProgressPanel.vue";
import BrowserAdvisoryBanner from "@/features/transcription/components/BrowserAdvisoryBanner.vue";
import LiveMicrophonePanel from "@/features/transcription/components/LiveMicrophonePanel.vue";
import { useLivePipeline } from "@/features/transcription/composables/useLivePipeline";
import { useMicrophoneDevices } from "@/features/transcription/composables/useMicrophoneDevices.js";
import {
  getTranscriptionRouteState,
  transcriptionDetailLocation,
  transcriptionHistoryLocation,
  transcriptionStartLocation,
} from "@/features/transcription/lib/transcriptionRoutes.js";

const store = useTranscriptionStore();
const toast = inject("toast");
const route = useRoute();
const router = useRouter();

useRuntimeDetection(store);
const modelManager = useModelManager(store);
const pipeline = useTranscriptionPipeline(store);
const livePipeline = useLivePipeline(store);
const microphoneDevices = useMicrophoneDevices(store);
const transcriptionExport = useTranscriptionExport(store);
const transcriptionHistory = useTranscriptionHistory();

const activeTranscriptId = ref(/** @type {string | null} */ (null));
const historySummaries = ref(
  /** @type {import('@/features/transcription/lib/transcriptionDb').TranscriptSummary[]} */ ([]),
);
const isLoadingHistory = ref(false);
const searchQuery = ref("");
const audioRef = ref(null);
const waveformTrackRef = ref(null);
const segmentRowRefs = new Map();
const isAudioPlaying = ref(false);
const playbackProgress = ref(0);
const currentPlaybackTime = ref(0);
const waveformSamples = ref([]);
const isSeekingWaveform = ref(false);
const hoverPlaybackRatio = ref(null);
const waveformAbortController = ref(null);
const isSpeakerPanelOpen = ref(true);
const isTranscriptCopied = ref(false);
const isStoppingLive = ref(false);
const isLiveRecordingExporting = ref(false);
const liveRecordingExportError = ref(false);
const isLiveRecordingResult = ref(false);
const hasReprocessedLiveRecording = ref(false);
const liveScrollAreaRef = ref(null);
const historyAudioBlob = ref(/** @type {Blob | null} */ (null));
const isHydratingHistory = ref(false);
const prefetchPromise = ref(
  /** @type {Promise<Record<string, ArrayBuffer>> | null} */ (null),
);
const isAwaitingPrefetch = ref(false);
let transcriptionStartToken = 0;
let liveStartToken = 0;
let transcriptCopiedTimeoutId = null;
let persistHistoryTimeoutId = null;
const MAX_LOCAL_FILE_SIZE_BYTES = 1024 * 1024 * 1024;
const MAX_LOCAL_DURATION_SECONDS = 3 * 60 * 60;
const LIVE_TRANSCRIPT_FOLLOW_THRESHOLD_PX = 200;
const DEFAULT_WAVEFORM_BAR_COUNT = 260;
const PREFETCH_ASR_ASSET_COUNT = 3;
const PREFETCH_TOTAL_ASSET_COUNT = 4;
let routeSyncToken = 0;
// micLevel is normalised 0–1 (255 = max byte frequency), but typical loud speech
// sits well below 1.0. Capping the bar at this value makes it feel full at a
// realistic peak rather than barely moving most of the time.
const MIC_LEVEL_BAR_MAX = 0.5;
const SPEAKER_COLORS = [
  "#2563eb",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#e11d48",
  "#0f766e",
  "#0891b2",
  "#c026d3",
];

const preflightWarning = computed(() => {
  if (!store.file) return null;

  if (store.fileSize > MAX_LOCAL_FILE_SIZE_BYTES) {
    return "This file is over 1 GB and may exceed browser memory limits. Use a smaller file or split it before transcribing.";
  }

  if (store.fileDuration && store.fileDuration > MAX_LOCAL_DURATION_SECONDS) {
    return "This file is over 3 hours long and may exceed browser memory limits. Split it into shorter files before transcribing.";
  }

  return null;
});

const blocksTranscription = computed(() => Boolean(preflightWarning.value));
const shouldShowBrowserAdvisory = computed(() => !isChromeBrowser());
const hasMemoryAdvisory = computed(() => store.runtimeAdvisory === "memory");
const advisoryVariant = computed(() => {
  if (shouldShowBrowserAdvisory.value && hasMemoryAdvisory.value) {
    return "browser-memory";
  }
  if (hasMemoryAdvisory.value) return "memory";
  return "browser";
});
const shouldShowRuntimeAdvisory = computed(
  () => shouldShowBrowserAdvisory.value || hasMemoryAdvisory.value,
);
const transcriptionRouteState = computed(() =>
  getTranscriptionRouteState(route),
);
const isStartSurface = computed(
  () => transcriptionRouteState.value.surface === "start",
);
const isBrowsingHistory = computed(
  () => transcriptionRouteState.value.surface === "history",
);
const transcriptSegments = computed(() =>
  store.segments.map((segment) => ({
    ...segment,
    speakerLabel: segment.speaker
      ? (store.speakerNames[segment.speaker] ?? segment.speaker)
      : null,
  })),
);
const filteredSegments = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return transcriptSegments.value;
  return transcriptSegments.value.filter((segment) =>
    `${segment.speakerLabel || ""} ${segment.text}`
      .toLowerCase()
      .includes(query),
  );
});
const showDropZone = computed(
  () =>
    isBrowsingHistory.value ||
    (isStartSurface.value &&
      !isAwaitingPrefetch.value &&
      !store.isProcessing &&
      !store.segments.length &&
      store.processPhase !== "complete" &&
      store.processPhase !== "error" &&
      !store.isListening),
);
const prefetchModelProgress = computed(() => {
  const parakeetProgress = Math.min(
    100,
    Math.max(0, store.parakeetLoadProgress || 0),
  );
  const sortformerProgress = Math.min(
    100,
    Math.max(0, store.sortformerLoadProgress || 0),
  );
  return (
    (parakeetProgress * PREFETCH_ASR_ASSET_COUNT + sortformerProgress) /
    PREFETCH_TOTAL_ASSET_COUNT
  );
});
const hasHistory = computed(() => historySummaries.value.length > 0);
const RECENT_TRANSCRIPT_LIMIT = 5;
const recentSummaries = computed(() =>
  historySummaries.value.slice(0, RECENT_TRANSCRIPT_LIMIT),
);
const hasMoreHistory = computed(
  () => historySummaries.value.length > RECENT_TRANSCRIPT_LIMIT,
);
const showActiveLiveSession = computed(
  () => isStartSurface.value && store.liveMode && store.isListening,
);
const liveStatusLabel = computed(() => {
  if (store.micInputState === "switching") return "Switching microphone...";
  if (store.micInputState === "interrupted") return "Input interrupted";
  if (store.micInputState === "unavailable") return "Input unavailable";
  return store.isPaused ? "Paused" : "Listening";
});
const liveStatusDotClass = computed(() => {
  if (
    store.micInputState === "interrupted" ||
    store.micInputState === "unavailable"
  ) {
    return "bg-destructive";
  }
  if (store.micInputState === "switching") return "animate-pulse bg-amber-500";
  return store.isPaused ? "bg-amber-500" : "animate-pulse bg-red-500";
});
const showLiveSession = computed(
  () =>
    isStartSurface.value &&
    store.liveMode &&
    store.isProcessing &&
    !store.isListening &&
    !isReprocessing.value,
);
const showEmptyCompletion = computed(
  () =>
    store.processPhase === "complete" &&
    !store.isProcessing &&
    !store.segments.length,
);
const showTranscriptResult = computed(
  () =>
    (transcriptionRouteState.value.surface === "detail" ||
      (isStartSurface.value && activeTranscriptId.value === null)) &&
    store.segments.length > 0 &&
    !store.isProcessing &&
    !store.isListening,
);
const speakerIds = computed(() => store.speakerList);
const fileDurationLabel = computed(() =>
  formatDuration(store.fileDuration || 0),
);
const currentPlaybackLabel = computed(
  () => formatDuration(currentPlaybackTime.value || 0) || "0:00",
);
const totalPlaybackLabel = computed(() => {
  const audio = audioRef.value;
  return formatDuration(audio?.duration || store.fileDuration || 0) || "0:00";
});
// Reserve exactly "<total> / <total>" so the label never wraps or jitters as the
// current time gains digits — font-mono makes every character 1ch wide.
const playbackLabelMinWidth = computed(() => {
  const total = totalPlaybackLabel.value || "0:00";
  return `${total.length * 2 + 3}ch`;
});
const activeSegmentId = computed(() => {
  const time = currentPlaybackTime.value;
  const active = filteredSegments.value.find(
    (segment) => time >= segment.start && time <= segment.end,
  );
  return active?.id || null;
});
const speakerColorMap = computed(() => {
  const map = new Map();
  speakerIds.value.forEach((speakerId, index) => {
    map.set(
      speakerId,
      store.speakerColors[speakerId] ||
        SPEAKER_COLORS[index % SPEAKER_COLORS.length],
    );
  });
  return map;
});
const canRemoveSpeaker = computed(() => speakerIds.value.length > 1);
const waveformBars = computed(() => {
  const samples = waveformSamples.value.length
    ? waveformSamples.value
    : fallbackWaveformSamples(DEFAULT_WAVEFORM_BAR_COUNT);
  return samples.map((sample) => ({
    height: 8 + Math.round(sample * 38),
  }));
});
// The played/hovered fill is rendered as overlay layers that share the exact bar
// layout of the base layer and are clipped to `ratio%` from the right. Because the
// clip uses the same percentage origin as the hover line (left: ratio * 100%), the
// fill boundary and the line stay pixel-aligned regardless of bar count, gaps, or
// track width — index-based per-bar coloring drifted from the line otherwise.
const clampRatio = (value) => Math.min(1, Math.max(0, value ?? 0));
const activeFillStyle = computed(() => ({
  clipPath: `inset(0 ${(1 - clampRatio(playbackProgress.value)) * 100}% 0 0)`,
}));
const previewFillStyle = computed(() => ({
  clipPath: `inset(0 ${(1 - clampRatio(hoverPlaybackRatio.value)) * 100}% 0 0)`,
}));
const hoverSeekerStyle = computed(() => ({
  left: `${clampRatio(hoverPlaybackRatio.value) * 100}%`,
}));

onMounted(async () => {
  document.title = `${APP_NAME} Transcribe`;
  trackAnalyticsEvent("page_navigation", {
    page_location: "transcribe_page",
  });
  await refreshHistorySummaries();
  await modelManager.checkCache();

  // After cache state is known, start background model pre-download once
  // runtime detection resolves so the worker starts from cache on first use.
  function startPrefetch() {
    if (store.parakeetCached) return;
    const promise = modelManager.ensureModelsReady(
      store.effectiveRuntime,
      true,
    );
    prefetchPromise.value = promise;
    promise.then(
      () => {
        prefetchPromise.value = null;
      },
      () => {
        prefetchPromise.value = null;
      },
    );
  }
  if (store.detectedRuntime) {
    // Runtime already known (e.g. returning to page — Pinia store persists).
    startPrefetch();
  } else {
    const unwatchRuntime = watch(
      () => store.detectedRuntime,
      (runtime) => {
        if (!runtime) return;
        unwatchRuntime();
        startPrefetch();
      },
    );
  }
});

watch(
  [() => route.name, () => route.params.transcriptId],
  () => {
    void syncTranscriptionRoute();
  },
  { immediate: true },
);

watch(
  () => store.audioUrl,
  (audioUrl) => {
    loadWaveform(audioUrl);
  },
  { immediate: true },
);

watch(activeSegmentId, async (segmentId) => {
  if (!segmentId || !isAudioPlaying.value) return;
  await scrollSegmentIntoView(segmentId);
});

watch(
  () => store.segments.length,
  async () => {
    if (!store.isListening) return;
    const viewport = liveScrollAreaRef.value?.viewport?.();
    if (!viewport) return;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const shouldFollow =
      distanceFromBottom < LIVE_TRANSCRIPT_FOLLOW_THRESHOLD_PX;
    if (!shouldFollow) return;

    await nextTick();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  },
  { flush: "pre" },
);

watch(
  [
    () => store.processPhase,
    () => store.segments,
    () => store.speakerNames,
    () => store.speakerColors,
    () => store.addedSpeakerIds,
  ],
  () => {
    if (isHydratingHistory.value) return;
    if (store.processPhase !== "complete") return;
    if (!store.segments.length) return;
    scheduleHistoryPersist();
  },
  { deep: true },
);

function handleFileSelected(file) {
  store.setFile(file);
  isLiveRecordingResult.value = false;
  hasReprocessedLiveRecording.value = false;
  historyAudioBlob.value = file;

  // Estimate duration via Web Audio API
  const url = URL.createObjectURL(file);
  store.audioUrl = url;
  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = url;
  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration)) {
      store.fileDuration = audio.duration;
    }
  });
}

function handleClearFile() {
  store.clearFile();
}

async function handleStartOver() {
  if (store.liveMode) {
    livePipeline.cancel();
  } else {
    pipeline.cancel();
  }
  // The completed transcript stays in history; Start Over only resets the
  // working view and returns to the start screen.
  resetWorkingTranscriptState();
  await refreshHistorySummaries();
  if (transcriptionRouteState.value.surface !== "start") {
    await router.push(transcriptionStartLocation());
  }
}

function resetWorkingTranscriptState() {
  activeTranscriptId.value = null;
  historyAudioBlob.value = null;
  if (persistHistoryTimeoutId !== null) {
    window.clearTimeout(persistHistoryTimeoutId);
    persistHistoryTimeoutId = null;
  }
  livePipeline.discardCapturedPcm();
  store.clearFile();
  store.setLiveMode(false);
  isLiveRecordingResult.value = false;
  hasReprocessedLiveRecording.value = false;
  searchQuery.value = "";
  playbackProgress.value = 0;
  currentPlaybackTime.value = 0;
  isAudioPlaying.value = false;
  isReprocessing.value = false;
}

async function handleStartTranscription() {
  const startToken = ++transcriptionStartToken;
  if (prefetchPromise.value) {
    isAwaitingPrefetch.value = true;
    try {
      await prefetchPromise.value;
    } catch {
      // abort or network error — non-fatal, pipeline handles its own model loading
    } finally {
      isAwaitingPrefetch.value = false;
    }
  }
  if (startToken !== transcriptionStartToken) return;
  await pipeline.start();
  if (store.processPhase === "complete" && !store.segments.length) {
    store.processPhase = "error";
    store.error = {
      code: "ASR_EMPTY_RESULT",
      message:
        "The transcription model finished but did not produce readable text. Try switching runtime in settings or using a clearer audio sample.",
      recoverable: true,
    };
  }
  if (store.processPhase === "complete" && store.segments.length) {
    historyAudioBlob.value = store.file;
    await persistTranscriptRecord({
      audioBlob: store.file,
      audioFileName: store.fileName,
      audioMimeType: store.file?.type ?? null,
      isLiveRecording: false,
    });
  }
}

/**
 * Create or update the active history record from the current store state.
 * @param {{
 *   audioBlob?: Blob | null,
 *   audioFileName?: string | null,
 *   audioMimeType?: string | null,
 *   isLiveRecording?: boolean,
 *   hasReprocessedLiveRecording?: boolean,
 * }} [options]
 * @returns {Promise<string | null>}
 */
async function persistTranscriptRecord(options = {}) {
  if (!store.segments.length) return null;
  const recordId = await transcriptionHistory.saveTranscript({
    id: activeTranscriptId.value ?? undefined,
    fileName: store.fileName,
    fileSize: store.fileSize,
    fileDuration: store.fileDuration ?? store.liveElapsed,
    isLiveRecording: options.isLiveRecording ?? isLiveRecordingResult.value,
    hasReprocessedLiveRecording:
      options.hasReprocessedLiveRecording ?? hasReprocessedLiveRecording.value,
    audioBlob: options.audioBlob ?? historyAudioBlob.value,
    audioFileName: options.audioFileName ?? store.fileName,
    audioMimeType:
      options.audioMimeType ?? historyAudioBlob.value?.type ?? null,
    segments: store.segments,
    speakerNames: store.speakerNames,
    speakerColors: store.speakerColors,
    addedSpeakerIds: store.addedSpeakerIds,
  });
  activeTranscriptId.value = recordId;
  const routeState = transcriptionRouteState.value;
  if (routeState.surface !== "detail" || routeState.transcriptId !== recordId) {
    await router.replace(transcriptionDetailLocation(recordId));
  }
  return recordId;
}

async function refreshHistorySummaries() {
  isLoadingHistory.value = true;
  try {
    historySummaries.value = await transcriptionHistory.listSummaries();
  } catch (error) {
    console.error("[transcription] Failed to load history:", error);
    historySummaries.value = [];
  } finally {
    isLoadingHistory.value = false;
  }
}

/**
 * Hydrate the store + working view from a loaded history record.
 * @param {import('@/features/transcription/lib/transcriptionDb').TranscriptHistoryEntry} record
 */
function hydrateFromRecord(record) {
  isHydratingHistory.value = true;
  try {
    store.clearFile();
    const hydratedFile = new File(
      [record.audioBlob],
      record.audioFileName || record.fileName || "transcript-audio",
      { type: record.audioMimeType || record.audioBlob.type || "audio/mpeg" },
    );
    historyAudioBlob.value = record.audioBlob;
    store.file = hydratedFile;
    store.fileName = record.fileName;
    store.fileSize = record.fileSize;
    store.fileDuration = record.fileDuration;
    store.segments = record.segments;
    store.speakerNames = record.speakerNames;
    store.speakerColors = record.speakerColors;
    store.addedSpeakerIds = record.addedSpeakerIds ?? [];
    store.processPhase = "complete";
    store.audioUrl = URL.createObjectURL(record.audioBlob);
    isLiveRecordingResult.value =
      Boolean(record.isLiveRecording) ||
      record.audioFileName === "live-recording" ||
      /^Live Recording\b/.test(record.fileName || record.audioFileName || "");
    hasReprocessedLiveRecording.value = Boolean(
      record.hasReprocessedLiveRecording,
    );
  } finally {
    isHydratingHistory.value = false;
  }
}

async function handleOpenBrowse() {
  await router.push(transcriptionHistoryLocation());
  trackAnalyticsEvent("transcribe_history_opened", {
    record_count: historySummaries.value.length,
  });
}

async function handleBackToNew() {
  await router.push(transcriptionStartLocation());
}

async function handleOpenRecord(id) {
  await router.push(transcriptionDetailLocation(id));
}

async function handleDeleteRecord(id) {
  await transcriptionHistory.deleteTranscript(id);
  if (activeTranscriptId.value === id) {
    activeTranscriptId.value = null;
    if (transcriptionRouteState.value.surface === "detail") {
      await router.replace(transcriptionHistoryLocation());
    }
  }
  await refreshHistorySummaries();
  trackAnalyticsEvent("transcribe_history_record_deleted", {});
}

async function handleDeleteAllRecords() {
  await transcriptionHistory.deleteAll();
  activeTranscriptId.value = null;
  if (transcriptionRouteState.value.surface === "detail") {
    await router.replace(transcriptionHistoryLocation());
  }
  await refreshHistorySummaries();
  trackAnalyticsEvent("transcribe_history_cleared", {});
}

async function syncTranscriptionRoute() {
  const syncToken = ++routeSyncToken;
  const routeState = transcriptionRouteState.value;

  if (routeState.surface === "invalid-detail") {
    toast?.({
      title: "Couldn't open transcript",
      description:
        "This saved transcript could not be loaded. It may have been removed.",
    });
    await router.replace(transcriptionHistoryLocation());
    return;
  }

  if (routeState.surface === "history") {
    await refreshHistorySummaries();
    return;
  }

  if (routeState.surface === "start") {
    if (activeTranscriptId.value && !store.isProcessing && !store.isListening) {
      resetWorkingTranscriptState();
    }
    return;
  }

  if (
    activeTranscriptId.value === routeState.transcriptId &&
    store.segments.length > 0 &&
    store.processPhase === "complete"
  ) {
    return;
  }

  let record = null;
  try {
    record = await transcriptionHistory.loadTranscript(routeState.transcriptId);
  } catch (error) {
    console.error("[transcription] Failed to open routed transcript:", error);
  }
  if (syncToken !== routeSyncToken) return;

  if (!record) {
    toast?.({
      title: "Couldn't open transcript",
      description:
        "This saved transcript could not be loaded. It may have been removed.",
    });
    await refreshHistorySummaries();
    if (syncToken === routeSyncToken) {
      await router.replace(transcriptionHistoryLocation());
    }
    return;
  }

  hydrateFromRecord(record);
  activeTranscriptId.value = record.id;
  searchQuery.value = "";
  playbackProgress.value = 0;
  currentPlaybackTime.value = 0;
  isAudioPlaying.value = false;
  trackAnalyticsEvent("transcribe_history_record_opened", {
    is_live_recording: isLiveRecordingResult.value,
  });
}

function scheduleHistoryPersist() {
  if (persistHistoryTimeoutId !== null) {
    window.clearTimeout(persistHistoryTimeoutId);
  }
  persistHistoryTimeoutId = window.setTimeout(async () => {
    persistHistoryTimeoutId = null;
    // Only persist edits to a record that already exists; new records are
    // created explicitly by the completion handlers.
    if (!activeTranscriptId.value) return;
    await persistTranscriptRecord({
      audioBlob: historyAudioBlob.value,
      audioFileName: store.fileName,
    });
  }, 250);
}

function handleCancel() {
  if (isReprocessing.value) {
    pipeline.cancel();
  } else if (store.liveMode) {
    livePipeline.cancel();
  } else {
    pipeline.cancel();
  }
}

function handleCancelPrefetchWait() {
  if (store.liveMode) {
    handleCancelLivePrefetch();
    return;
  }
  transcriptionStartToken += 1;
  isAwaitingPrefetch.value = false;
}

async function handleStartLive() {
  const startToken = ++liveStartToken;
  store.setLiveMode(true);
  isLiveRecordingResult.value = true;
  hasReprocessedLiveRecording.value = false;
  if (prefetchPromise.value) {
    isAwaitingPrefetch.value = true;
    try {
      await prefetchPromise.value;
    } catch {
      // non-fatal
    } finally {
      isAwaitingPrefetch.value = false;
    }
  }
  if (startToken !== liveStartToken) return;
  await livePipeline.start();
  await microphoneDevices.refreshMicrophones();
}

function handleCancelLivePrefetch() {
  liveStartToken += 1;
  isAwaitingPrefetch.value = false;
  store.setLiveMode(false);
}

function handlePauseLive() {
  livePipeline.pause();
}

function handleResumeLive() {
  livePipeline.resume();
}

async function handleSelectMicrophone(deviceId) {
  try {
    await livePipeline.switchInput(deviceId);
    await microphoneDevices.refreshMicrophones();
  } catch {
    // Inline state is set by the live pipeline.
  }
}

async function handleRetryMicrophone() {
  try {
    await livePipeline.retryInput();
    await microphoneDevices.refreshMicrophones();
  } catch {
    // Inline state is set by the live pipeline.
  }
}

async function handleStopLive() {
  isStoppingLive.value = true;
  await livePipeline.stop();
  if (store.processPhase === "complete" && store.segments.length) {
    const liveAudioBlob = createLiveRecordingAudioBlob();
    if (liveAudioBlob) {
      historyAudioBlob.value = liveAudioBlob;
      if (store.audioUrl) {
        URL.revokeObjectURL(store.audioUrl);
      }
      store.audioUrl = URL.createObjectURL(liveAudioBlob);
    }
    await persistTranscriptRecord({
      audioBlob: liveAudioBlob,
      audioFileName: "live-recording",
      audioMimeType: liveAudioBlob?.type ?? null,
      isLiveRecording: true,
      hasReprocessedLiveRecording: false,
    });
  }
}

const canReprocess = computed(
  () =>
    isLiveRecordingResult.value &&
    showTranscriptResult.value &&
    !hasReprocessedLiveRecording.value,
);
const hasDownloadableLiveRecordingAudio = computed(
  () =>
    livePipeline.capturedPcm.value != null ||
    (historyAudioBlob.value != null && historyAudioBlob.value.size > 0),
);
const canDownloadLiveRecording = computed(
  () =>
    isLiveRecordingResult.value &&
    showTranscriptResult.value &&
    hasDownloadableLiveRecordingAudio.value,
);
const isReprocessing = ref(false);

async function handleReprocess() {
  const pcm = livePipeline.capturedPcm.value;

  isReprocessing.value = true;
  store.setEnableDiarization(true);
  try {
    if (pcm) {
      // Same session: PCM is in memory — skip transcode, feed directly
      // Make a copy since diarization transfers the buffer
      const pcmCopy = new Float32Array(pcm);
      await pipeline.reprocessFromPcm(pcmCopy, { enableDiarization: true });
    } else {
      // After reload: PCM is gone but store.file is hydrated from the saved
      // WAV blob (16kHz mono, lossless), so transcode overhead is negligible
      await pipeline.start();
    }
  } finally {
    isReprocessing.value = false;
  }

  if (store.processPhase === "complete" && store.segments.length) {
    hasReprocessedLiveRecording.value = true;
    // After reload capturedPcm is gone, so fall back to the already-hydrated blob
    const liveAudioBlob =
      createLiveRecordingAudioBlob() ?? historyAudioBlob.value;
    if (liveAudioBlob && !store.audioUrl) {
      historyAudioBlob.value = liveAudioBlob;
      store.audioUrl = URL.createObjectURL(liveAudioBlob);
    }
    await persistTranscriptRecord({
      audioBlob: liveAudioBlob,
      audioFileName: store.fileName,
      audioMimeType: liveAudioBlob?.type ?? null,
      isLiveRecording: true,
      hasReprocessedLiveRecording: true,
    });
  }
}

async function handleClearCache() {
  await modelManager.clearModelCache();
  toast?.({
    description: "Model cache cleared.",
  });
}

async function handleCopyTranscript() {
  const success = await copyContent(formatPlainText(store.displaySegments));
  if (!success) {
    toast?.({
      title: "Copy failed",
      description: "Failed to copy transcript. Please try again.",
    });
    return;
  }
  isTranscriptCopied.value = true;
  if (transcriptCopiedTimeoutId !== null) {
    window.clearTimeout(transcriptCopiedTimeoutId);
  }
  transcriptCopiedTimeoutId = window.setTimeout(() => {
    isTranscriptCopied.value = false;
    transcriptCopiedTimeoutId = null;
  }, 1600);
}

async function handleDownloadLiveRecording() {
  if (!canDownloadLiveRecording.value || isLiveRecordingExporting.value) return;

  isLiveRecordingExporting.value = true;
  liveRecordingExportError.value = false;
  try {
    const mp3Data = await createLiveRecordingMp3();
    const blob = new Blob([mp3Data], { type: "audio/mpeg" });
    saveAs(
      blob,
      `${transcriptBaseName(store.fileName || "live-recording")}.mp3`,
    );
    trackAnalyticsEvent("live_recording_downloaded", {
      format: "mp3",
      durationSec: store.fileDuration || store.liveElapsed || null,
    });
  } catch (error) {
    console.error("[live-transcription] MP3 export failed:", error);
    liveRecordingExportError.value = true;
    toast?.({
      title: "Download failed",
      description:
        "Could not create an MP3 for this live recording. Please try again.",
    });
  } finally {
    isLiveRecordingExporting.value = false;
  }
}

/**
 * @returns {Promise<ArrayBuffer>}
 */
async function createLiveRecordingMp3() {
  const pcm = livePipeline.capturedPcm.value;
  if (pcm) {
    const wavBlob = createWavBlobFromPcm(pcm, { sampleRate: 16000 });
    const wavData = await wavBlob.arrayBuffer();
    return await exportLiveRecordingMp3(wavData, store.fileName);
  }

  if (!store.audioUrl) {
    throw new Error("Live recording audio is unavailable");
  }

  const response = await fetch(store.audioUrl);
  if (!response.ok) {
    throw new Error(`Could not read live recording audio: ${response.status}`);
  }
  const fileData = await response.arrayBuffer();
  if (fileData.byteLength === 0) {
    throw new Error(
      "The saved live recording audio is empty. Start a new live recording to download audio.",
    );
  }
  return await exportAudioRecordingMp3(
    fileData,
    store.fileName,
    response.headers.get("content-type"),
  );
}

/**
 * @returns {Blob | null}
 */
function createLiveRecordingAudioBlob() {
  const pcm = livePipeline.capturedPcm.value;
  if (!pcm) return null;
  return createWavBlobFromPcm(pcm, { sampleRate: 16000 });
}

/**
 * @param {ArrayBuffer} wavData
 * @param {string} fileName
 * @returns {Promise<ArrayBuffer>}
 */
function exportLiveRecordingMp3(wavData, fileName) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("@/workers/ffmpegWorker.js", import.meta.url),
      {
        type: "module",
      },
    );

    const cleanup = () => {
      worker.terminate();
    };

    worker.onmessage = (event) => {
      const { type, payload } = event.data;
      if (type === "mp3-complete") {
        cleanup();
        resolve(payload.mp3Data);
        return;
      }
      if (type === "error") {
        cleanup();
        reject(new Error(payload?.message || "MP3 export failed"));
      }
    };

    worker.onerror = (error) => {
      cleanup();
      reject(new Error(`FFmpeg worker error: ${error.message}`));
    };

    worker.postMessage(
      {
        type: "export-mp3",
        payload: {
          wavData,
          fileName: `${transcriptBaseName(fileName || "live-recording")}.wav`,
        },
      },
      [wavData],
    );
  });
}

/**
 * @param {ArrayBuffer} fileData
 * @param {string} fileName
 * @param {string | null} mimeType
 * @returns {Promise<ArrayBuffer>}
 */
function exportAudioRecordingMp3(fileData, fileName, mimeType = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("@/workers/ffmpegWorker.js", import.meta.url),
      {
        type: "module",
      },
    );

    const cleanup = () => {
      worker.terminate();
    };

    worker.onmessage = (event) => {
      const { type, payload } = event.data;
      if (type === "mp3-complete") {
        cleanup();
        resolve(payload.mp3Data);
        return;
      }
      if (type === "error") {
        cleanup();
        reject(new Error(payload?.message || "MP3 export failed"));
      }
    };

    worker.onerror = (error) => {
      cleanup();
      reject(new Error(`FFmpeg worker error: ${error.message}`));
    };

    worker.postMessage(
      {
        type: "export-audio-mp3",
        payload: {
          fileData,
          fileName: liveRecordingAudioInputName(fileName, mimeType),
          mimeType,
        },
      },
      [fileData],
    );
  });
}

/**
 * @param {string} fileName
 * @param {string | null} mimeType
 * @returns {string}
 */
function liveRecordingAudioInputName(fileName, mimeType) {
  const baseName = transcriptBaseName(fileName || "live-recording");
  if (mimeType?.includes("wav")) return `${baseName}.wav`;
  if (mimeType?.includes("mpeg") || mimeType?.includes("mp3"))
    return `${baseName}.mp3`;
  if (mimeType?.includes("webm")) return `${baseName}.webm`;
  if (mimeType?.includes("ogg")) return `${baseName}.ogg`;
  return `${baseName}.wav`;
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const safeSeconds = Math.max(0, seconds);
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = Math.floor(safeSeconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function handleSpeakerRename(speakerId, event) {
  const target = /** @type {HTMLInputElement | null} */ (event.target);
  store.renameSpeaker(speakerId, target?.value || speakerId);
}

function addSpeaker() {
  store.addSpeaker();
}

function addSpeakerForSegment(segmentId) {
  const speakerId = store.addSpeaker();
  store.assignSegmentSpeaker(segmentId, speakerId);
}

function speakerLabel(speakerId) {
  return speakerId
    ? (store.speakerNames[speakerId] ?? speakerId)
    : "Unassigned";
}

function handleSpeakerColorChange(speakerId, event) {
  const target = /** @type {HTMLInputElement | null} */ (event.target);
  if (target?.value) {
    store.setSpeakerColor(speakerId, target.value);
  }
}

async function playSegment(segment) {
  const audio = audioRef.value;
  if (!audio) return;
  audio.currentTime = Math.max(0, segment.start || 0);
  currentPlaybackTime.value = audio.currentTime;
  await audio.play();
  isAudioPlaying.value = true;
  await scrollSegmentIntoView(segment.id);
}

function isSegmentActive(segment) {
  return (
    currentPlaybackTime.value >= segment.start &&
    currentPlaybackTime.value <= segment.end
  );
}

function isWordActive(word) {
  return (
    currentPlaybackTime.value >= word.start &&
    currentPlaybackTime.value <= word.end
  );
}

function segmentWords(segment) {
  if (Array.isArray(segment.words) && segment.words.length > 0) {
    return segment.words.map((word) => ({
      ...word,
      text: normalizeDisplayedWord(word.text),
    }));
  }
  const words = segment.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const duration = Math.max(0.01, segment.end - segment.start);
  const step = duration / words.length;
  return words.map((word, index) => ({
    text: word,
    start: segment.start + index * step,
    end: segment.start + (index + 1) * step,
  }));
}

async function toggleAudioPlayback() {
  const audio = audioRef.value;
  if (!audio) return;
  if (audio.paused) {
    await audio.play();
    isAudioPlaying.value = true;
  } else {
    audio.pause();
    isAudioPlaying.value = false;
  }
}

function handleAudioTimeUpdate(event) {
  const audio = /** @type {HTMLAudioElement} */ (event.target);
  currentPlaybackTime.value = audio.currentTime;
  playbackProgress.value = audio.duration
    ? Math.min(1, Math.max(0, audio.currentTime / audio.duration))
    : 0;
}

function handleAudioEnded() {
  isAudioPlaying.value = false;
  playbackProgress.value = 0;
  currentPlaybackTime.value = 0;
}

function normalizeDisplayedWord(text) {
  return `${text || ""}`.replace(/\s+/g, " ").trim();
}

function setSegmentRowRef(segmentId, element) {
  if (element) {
    segmentRowRefs.set(segmentId, element);
  } else {
    segmentRowRefs.delete(segmentId);
  }
}

async function scrollSegmentIntoView(segmentId) {
  await nextTick();
  segmentRowRefs.get(segmentId)?.scrollIntoView({
    block: "center",
    behavior: "auto",
  });
}

async function scrollToPlaybackTime(time) {
  const active = filteredSegments.value.find(
    (segment) => time >= segment.start && time <= segment.end,
  );
  if (active) {
    await scrollSegmentIntoView(active.id);
  }
}

function speakerStyle(speakerId) {
  const color = speakerColorMap.value.get(speakerId) || SPEAKER_COLORS[0];
  return {
    color,
    borderColor: `${color}4d`,
    backgroundColor: `${color}14`,
  };
}

async function loadWaveform(audioUrl) {
  waveformAbortController.value?.abort();
  waveformSamples.value = [];
  if (!audioUrl) return;

  const controller = new AbortController();
  waveformAbortController.value = controller;

  try {
    const response = await fetch(audioUrl, { signal: controller.signal });
    const buffer = await response.arrayBuffer();
    if (controller.signal.aborted) return;

    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    if (controller.signal.aborted) {
      await context.close?.();
      return;
    }

    waveformSamples.value = extractWaveformSamples(
      audioBuffer,
      DEFAULT_WAVEFORM_BAR_COUNT,
    );
    await context.close?.();
  } catch (error) {
    if (error?.name !== "AbortError") {
      waveformSamples.value = fallbackWaveformSamples(
        DEFAULT_WAVEFORM_BAR_COUNT,
      );
    }
  }
}

function extractWaveformSamples(audioBuffer, count) {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1);
  const length = audioBuffer.length;
  const samplesPerBar = Math.max(1, Math.floor(length / count));
  const bars = [];
  let maxRms = 0;

  for (let barIndex = 0; barIndex < count; barIndex += 1) {
    const start = barIndex * samplesPerBar;
    const end = Math.min(length, start + samplesPerBar);
    let sum = 0;
    let sampleCount = 0;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      for (let index = start; index < end; index += 1) {
        sum += data[index] * data[index];
        sampleCount += 1;
      }
    }

    const rms = Math.sqrt(sum / Math.max(1, sampleCount));
    maxRms = Math.max(maxRms, rms);
    bars.push(rms);
  }

  return bars.map((value) => Math.max(0.08, value / Math.max(maxRms, 0.001)));
}

function fallbackWaveformSamples(count) {
  return Array.from({ length: count }, (_, index) => {
    const value = Math.abs(Math.sin(index * 0.53) * Math.cos(index * 0.17));
    return Math.max(0.12, value);
  });
}

function getWaveformRatio(event) {
  const track = waveformTrackRef.value;
  if (!track) return null;

  const rect = track.getBoundingClientRect();
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
}

function updateWaveformHover(event) {
  hoverPlaybackRatio.value = getWaveformRatio(event);
}

function clearWaveformHover() {
  if (!isSeekingWaveform.value) {
    hoverPlaybackRatio.value = null;
  }
}

function seekWaveform(event) {
  const audio = audioRef.value;
  const ratio = getWaveformRatio(event);
  if (!audio || ratio === null || !audio.duration) return;

  audio.currentTime = ratio * audio.duration;
  currentPlaybackTime.value = audio.currentTime;
  playbackProgress.value = ratio;
  scrollToPlaybackTime(audio.currentTime);
}

function handleWaveformPointerDown(event) {
  isSeekingWaveform.value = true;
  event.currentTarget.setPointerCapture?.(event.pointerId);
  updateWaveformHover(event);
  seekWaveform(event);
}

function handleWaveformPointerMove(event) {
  updateWaveformHover(event);
  if (!isSeekingWaveform.value) return;
  seekWaveform(event);
}

function handleWaveformPointerUp(event) {
  isSeekingWaveform.value = false;
  event.currentTarget.releasePointerCapture?.(event.pointerId);
  clearWaveformHover();
}

onUnmounted(() => {
  modelManager.abort();
  waveformAbortController.value?.abort();
  if (transcriptCopiedTimeoutId !== null) {
    window.clearTimeout(transcriptCopiedTimeoutId);
  }
  if (persistHistoryTimeoutId !== null) {
    window.clearTimeout(persistHistoryTimeoutId);
  }
  if (store.audioUrl) {
    URL.revokeObjectURL(store.audioUrl);
  }
  if (store.isListening) {
    livePipeline.cancel();
  }
  livePipeline.discardCapturedPcm();
});
</script>

<template>
  <TooltipProvider :delay-duration="120">
    <div
      v-if="showTranscriptResult"
      class="flex min-h-0 w-full max-w-full flex-1 flex-col overflow-hidden bg-muted text-foreground"
    >
      <header
        class="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-3"
      >
        <Button
          variant="outline"
          size="sm"
          class="h-9 rounded-md px-3 text-sm"
          @click="handleStartOver"
        >
          <ChevronLeft class="mr-0.5 h-4 w-4" />
          Back
        </Button>

        <label class="relative min-w-[220px] flex-1">
          <Search
            class="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground"
          />
          <input
            v-model="searchQuery"
            type="search"
            class="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            placeholder="Search transcript"
          />
        </label>

        <div class="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                class="h-9 w-9"
                @click="handleCopyTranscript"
              >
                <Check
                  v-if="isTranscriptCopied"
                  class="h-4 w-4 text-green-600"
                />
                <Copy v-else class="h-4 w-4" />
                <span class="sr-only">Copy transcript</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Copy transcript</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                class="h-9 w-9"
                @click="transcriptionExport.exportTranscript('txt')"
              >
                <Download class="h-4 w-4" />
                <span class="sr-only">Export text</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Export as text</p>
            </TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" class="h-9 w-9">
                <MoreHorizontal class="h-4 w-4" />
                <span class="sr-only">More export options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                @click="transcriptionExport.exportTranscript('md')"
              >
                <Download class="mr-2 h-4 w-4" />
                Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem
                @click="transcriptionExport.exportTranscript('srt')"
              >
                <Download class="mr-2 h-4 w-4" />
                Export as subtitle
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <!-- Reprocess banner for live recordings -->
      <div
        v-if="canReprocess"
        class="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-2.5"
      >
        <div
          class="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground"
        >
          <RefreshCw class="h-3.5 w-3.5 shrink-0" />
          <span
            >Reprocess this recording for better accuracy and speaker
            identification.</span
          >
        </div>
        <div class="flex items-center gap-3">
          <Button
            size="sm"
            class="h-8 px-3 text-xs"
            :disabled="isReprocessing"
            @click="handleReprocess"
          >
            <RefreshCw v-if="!isReprocessing" class="mr-1.5 h-3 w-3" />
            <Loader2 v-else class="mr-1.5 h-3 w-3 animate-spin" />
            Reprocess
          </Button>
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <main
          class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-card"
        >
          <ScrollArea class="min-h-0 min-w-0 flex-1">
            <div
              class="mx-auto w-full max-w-full px-4 pb-10 pt-8 sm:px-6 lg:max-w-5xl"
            >
              <div
                v-for="seg in filteredSegments"
                :key="seg.id"
                :ref="(element) => setSegmentRowRef(seg.id, element)"
                class="group -mx-3 min-w-0 border-b border-border/70 px-3 py-5 last:border-b-0 hover:rounded-md hover:bg-foreground/[0.04]"
                :class="[
                  store.audioUrl ? 'cursor-pointer' : '',
                  isSegmentActive(seg)
                    ? 'rounded-md bg-primary/10 opacity-100'
                    : 'opacity-80 hover:opacity-100',
                ]"
                @click="playSegment(seg)"
              >
                <div
                  class="mb-2 flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.1em]"
                >
                  <span class="text-muted-foreground">{{
                    formatDuration(seg.start)
                  }}</span>
                  <DropdownMenu v-if="store.enableDiarization">
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        class="group/speaker-pill inline-flex items-center gap-2 rounded-full border px-2 py-0.5"
                        :style="speakerStyle(seg.speaker || 'Speaker 1')"
                        @click.stop
                      >
                        {{ seg.speakerLabel || "Unassigned" }}
                        <ChevronDown
                          class="hidden h-3 w-3 group-hover/speaker-pill:block"
                        />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" class="w-44">
                      <DropdownMenuItem
                        v-for="speakerId in speakerIds"
                        :key="speakerId"
                        @click.stop="
                          store.assignSegmentSpeaker(seg.id, speakerId)
                        "
                      >
                        {{ speakerLabel(speakerId) }}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        @click.stop="addSpeakerForSegment(seg.id)"
                      >
                        <Plus class="mr-2 h-3.5 w-3.5" />
                        Add new speaker
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p
                  class="max-w-full whitespace-normal break-words text-lg font-medium leading-8 text-foreground [overflow-wrap:anywhere] md:text-xl md:leading-9"
                >
                  <template
                    v-for="(word, wordIndex) in segmentWords(seg)"
                    :key="`${seg.id}-${wordIndex}`"
                  >
                    <span
                      class="mr-[0.08em] inline-block rounded px-0.5"
                      :class="
                        isWordActive(word)
                          ? 'bg-primary text-primary-foreground'
                          : isSegmentActive(seg)
                            ? 'text-foreground'
                            : 'text-foreground/80'
                      "
                    >
                      {{ word.text }} </span
                    ><wbr />
                  </template>
                </p>
              </div>
              <p
                v-if="!filteredSegments.length"
                class="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
              >
                No transcript matches.
              </p>
            </div>
          </ScrollArea>

          <div
            v-if="store.audioUrl"
            class="max-w-full shrink-0 overflow-hidden border-t border-border bg-card/95 px-4 pb-4 pt-3 shadow-[0_-8px_24px_rgba(15,23,42,0.05)] backdrop-blur sm:px-5"
          >
            <span
              v-if="isLiveRecordingExporting"
              aria-hidden="true"
              class="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden"
            >
              <span
                class="live-export-shimmer block h-full w-1/3 bg-primary/80"
              />
            </span>
            <audio
              ref="audioRef"
              :src="store.audioUrl"
              @timeupdate="handleAudioTimeUpdate"
              @ended="handleAudioEnded"
              @pause="isAudioPlaying = false"
              @play="isAudioPlaying = true"
            />
            <div
              class="mb-3 flex min-w-0 items-center gap-4 text-[11px] text-muted-foreground"
            >
              <p class="min-w-0 flex-1 truncate">{{ store.fileName }}</p>
              <template v-if="canDownloadLiveRecording">
                <button
                  type="button"
                  :disabled="isLiveRecordingExporting"
                  :aria-busy="isLiveRecordingExporting"
                  class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70"
                  :class="
                    isLiveRecordingExporting
                      ? 'border-border text-muted-foreground'
                      : liveRecordingExportError
                        ? 'border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700'
                        : 'border-border text-foreground/80 hover:bg-muted hover:text-foreground'
                  "
                  @click="handleDownloadLiveRecording"
                >
                  <Loader2
                    v-if="isLiveRecordingExporting"
                    class="h-3 w-3 animate-spin"
                  />
                  <Download v-else class="h-3 w-3" />
                  <template v-if="isLiveRecordingExporting"
                    >Encoding MP3…</template
                  >
                  <template v-else-if="liveRecordingExportError"
                    >Encoding failed — retry</template
                  >
                  <template v-else>Save as MP3</template>
                </button>
              </template>
            </div>
            <div class="flex min-w-0 items-center gap-3">
              <Button
                variant="default"
                size="icon"
                class="h-11 w-11 shrink-0 rounded-full bg-primary text-primary-foreground shadow-sm transition-all hover:scale-[1.03] hover:bg-primary/90 hover:text-primary-foreground hover:shadow-md hover:ring-4 hover:ring-primary/10 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:hover:scale-100 disabled:hover:ring-0"
                :disabled="!store.audioUrl"
                @click="toggleAudioPlayback"
              >
                <Pause v-if="isAudioPlaying" class="h-4 w-4" />
                <Play v-else class="h-4 w-4 fill-current" />
              </Button>
              <div
                ref="waveformTrackRef"
                class="group relative flex h-12 min-w-0 flex-1 touch-none cursor-pointer items-center overflow-hidden"
                role="slider"
                :aria-valuenow="Math.round(playbackProgress * 100)"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-label="Playback position"
                @pointerdown="handleWaveformPointerDown"
                @pointermove="handleWaveformPointerMove"
                @pointerup="handleWaveformPointerUp"
                @pointercancel="handleWaveformPointerUp"
                @pointerleave="clearWaveformHover"
              >
                <!-- Base (unplayed) bars define the layout the overlays clip against. -->
                <div
                  class="pointer-events-none flex h-full w-full items-center gap-[2px]"
                >
                  <span
                    v-for="(bar, index) in waveformBars"
                    :key="index"
                    class="min-w-px flex-1 rounded-full bg-muted-foreground/30"
                    :style="{ height: `${bar.height}px` }"
                  />
                </div>
                <!-- Hover preview fill, clipped to the hovered ratio. -->
                <div
                  v-if="hoverPlaybackRatio !== null"
                  class="pointer-events-none absolute inset-0 flex h-full w-full items-center gap-[2px]"
                  :style="previewFillStyle"
                >
                  <span
                    v-for="(bar, index) in waveformBars"
                    :key="index"
                    class="min-w-px flex-1 rounded-full bg-primary/40"
                    :style="{ height: `${bar.height}px` }"
                  />
                </div>
                <!-- Played fill, clipped to the current playback ratio. -->
                <div
                  class="pointer-events-none absolute inset-0 flex h-full w-full items-center gap-[2px]"
                  :style="activeFillStyle"
                >
                  <span
                    v-for="(bar, index) in waveformBars"
                    :key="index"
                    class="min-w-px flex-1 rounded-full bg-primary"
                    :style="{ height: `${bar.height}px` }"
                  />
                </div>
                <span
                  v-if="hoverPlaybackRatio !== null"
                  class="pointer-events-none absolute top-1/2 h-11 w-px -translate-y-1/2 bg-primary/70 shadow-[0_0_0_3px_rgba(43,40,38,0.12)]"
                  :style="hoverSeekerStyle"
                />
              </div>
              <span
                class="shrink-0 whitespace-nowrap text-right font-mono text-xs text-muted-foreground"
                :style="{ minWidth: playbackLabelMinWidth }"
              >
                {{ currentPlaybackLabel }} /
                {{ totalPlaybackLabel || fileDurationLabel }}
              </span>
            </div>
          </div>
        </main>

        <aside
          v-if="
            store.enableDiarization && speakerIds.length && isSpeakerPanelOpen
          "
          class="hidden w-72 shrink-0 border-l border-border bg-card p-3 lg:block"
        >
          <div class="mb-4 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                class="h-8 w-8 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                @click="isSpeakerPanelOpen = false"
              >
                <PanelRight class="h-4 w-4" />
                <span class="sr-only">Collapse speakers panel</span>
              </Button>
              <h2 class="text-sm font-semibold">Speakers</h2>
            </div>
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8"
              @click="addSpeaker"
            >
              <Plus class="h-4 w-4" />
              <span class="sr-only">Add speaker</span>
            </Button>
          </div>
          <div class="space-y-2">
            <div
              v-for="speakerId in speakerIds"
              :key="speakerId"
              class="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2"
            >
              <label
                class="relative h-6 w-6 shrink-0 overflow-hidden rounded-full border border-border"
              >
                <span
                  class="block h-full w-full"
                  :style="{
                    backgroundColor:
                      speakerColorMap.get(speakerId) || SPEAKER_COLORS[0],
                  }"
                />
                <input
                  type="color"
                  class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  :value="speakerColorMap.get(speakerId) || SPEAKER_COLORS[0]"
                  @input="handleSpeakerColorChange(speakerId, $event)"
                />
              </label>
              <input
                class="h-8 min-w-0 flex-1 rounded-md border-0 bg-transparent px-1 text-sm outline-none focus:bg-muted/50"
                :value="speakerLabel(speakerId)"
                @input="handleSpeakerRename(speakerId, $event)"
              />
              <Button
                v-if="canRemoveSpeaker"
                variant="ghost"
                size="icon"
                class="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                @click="store.removeSpeaker(speakerId)"
              >
                <Trash2 class="h-3.5 w-3.5" />
                <span class="sr-only">Remove speaker</span>
              </Button>
            </div>
          </div>
        </aside>

        <div
          v-if="
            store.enableDiarization && speakerIds.length && !isSpeakerPanelOpen
          "
          class="pointer-events-none absolute right-4 top-28 z-30 hidden lg:block"
        >
          <div
            class="pointer-events-auto rounded-lg border bg-card/95 p-1 shadow-lg"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  @click="isSpeakerPanelOpen = true"
                >
                  <PanelRight class="h-4 w-4" />
                  <span class="sr-only">Open speakers panel</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>Open speakers panel</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>

    <!-- Active live session: full-height layout matching transcript result -->
    <div
      v-else-if="showActiveLiveSession"
      class="flex min-h-0 w-full max-w-full flex-1 flex-col overflow-hidden bg-muted text-foreground"
    >
      <header
        class="flex min-h-16 shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-5 py-3"
      >
        <Button
          variant="outline"
          size="sm"
          class="h-9 rounded-md px-3 text-sm"
          @click="handleStartOver"
        >
          <ChevronLeft class="mr-0.5 h-4 w-4" />
          Back
        </Button>

        <div class="ml-auto flex items-center gap-3">
          <Button
            variant="default"
            size="sm"
            class="h-9 shrink-0 rounded-md px-3 text-xs"
            :disabled="isStoppingLive"
            @click="handleStopLive"
          >
            <Loader2
              v-if="isStoppingLive"
              class="mr-1.5 h-3.5 w-3.5 animate-spin"
            />
            <Square v-else class="mr-1.5 h-3.5 w-3.5 fill-current" />
            {{ isStoppingLive ? "Stopping..." : "Stop Recording" }}
          </Button>
        </div>
      </header>

      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <main
          class="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-card"
        >
          <ScrollArea ref="liveScrollAreaRef" class="min-h-0 min-w-0 flex-1">
            <div
              class="mx-auto w-full max-w-full px-4 pb-10 pt-8 sm:px-6 lg:max-w-5xl"
            >
              <div
                v-for="seg in store.segments"
                :key="seg.id"
                class="group -mx-3 min-w-0 border-b border-border/70 px-3 py-5 last:border-b-0"
              >
                <div
                  class="mb-2 flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.1em]"
                >
                  <span class="text-muted-foreground">{{
                    formatDuration(seg.start)
                  }}</span>
                </div>
                <p
                  class="max-w-full whitespace-normal break-words text-lg font-medium leading-8 text-foreground [overflow-wrap:anywhere] md:text-xl md:leading-9"
                >
                  <span
                    v-for="(word, wordIndex) in segmentWords(seg)"
                    :key="`${seg.id}-${wordIndex}`"
                    class="mr-[0.08em] inline-block rounded px-0.5 text-foreground/80"
                  >
                    {{ word.text }}
                  </span>
                </p>
              </div>
              <p
                v-if="!store.segments.length"
                class="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
              >
                Waiting for speech...
              </p>
            </div>
          </ScrollArea>

          <!-- Bottom mic controls bar -->
          <div
            class="max-w-full shrink-0 overflow-hidden border-t border-border bg-card/95 px-4 pb-4 pt-3 shadow-[0_-8px_24px_rgba(15,23,42,0.05)] backdrop-blur sm:px-5"
          >
            <div
              class="mb-3 flex min-w-0 flex-wrap items-center gap-3 text-[11px] text-muted-foreground"
            >
              <p class="shrink-0 font-medium uppercase tracking-[0.08em]">
                Microphone input
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 min-w-0 max-w-full justify-start gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Mic class="h-3.5 w-3.5 shrink-0" />
                    <span class="min-w-0 truncate">{{
                      store.selectedMicLabel
                    }}</span>
                    <span
                      v-if="!store.selectedMicAvailable"
                      class="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                    >
                      Unavailable
                    </span>
                    <ChevronDown class="h-3.5 w-3.5 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" class="w-72">
                  <DropdownMenuItem
                    v-for="mic in store.availableMics"
                    :key="mic.deviceId"
                    class="flex min-w-0 cursor-pointer items-center gap-2"
                    :disabled="
                      !mic.available || store.micInputState === 'switching'
                    "
                    @click="handleSelectMicrophone(mic.deviceId)"
                  >
                    <Check
                      class="h-3.5 w-3.5 shrink-0"
                      :class="
                        mic.deviceId === store.selectedMicId
                          ? 'opacity-100'
                          : 'opacity-0'
                      "
                    />
                    <span class="min-w-0 flex-1 truncate">{{ mic.label }}</span>
                    <span
                      v-if="!mic.available"
                      class="shrink-0 text-[10px] text-destructive"
                    >
                      Unavailable
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p
                v-if="store.micInputError"
                class="min-w-[16rem] flex-1 truncate text-destructive"
              >
                {{ store.micInputError.message }}
              </p>
              <div
                v-if="
                  store.micInputState === 'interrupted' ||
                  store.micInputState === 'unavailable'
                "
                class="ml-auto flex shrink-0 items-center gap-2"
              >
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 rounded-md px-2 text-xs"
                  @click="handleRetryMicrophone"
                >
                  <RefreshCw class="mr-1.5 h-3 w-3" />
                  Retry
                </Button>
              </div>
              <div
                class="flex shrink-0 items-center gap-2"
                :class="
                  store.micInputState === 'interrupted' ||
                  store.micInputState === 'unavailable'
                    ? ''
                    : 'ml-auto'
                "
              >
                <span
                  class="inline-block h-2.5 w-2.5 rounded-full"
                  :class="liveStatusDotClass"
                />
                <span class="text-sm font-medium text-muted-foreground">
                  {{ liveStatusLabel }}
                </span>
              </div>
            </div>
            <div class="flex min-w-0 items-center gap-3">
              <!-- Pause / Resume -->
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="default"
                    size="icon"
                    class="h-11 w-11 shrink-0 rounded-full shadow-sm transition-all hover:scale-[1.03] hover:shadow-md"
                    :class="
                      store.isPaused
                        ? 'bg-destructive hover:bg-destructive/90 hover:ring-4 hover:ring-destructive/20'
                        : 'hover:ring-4 hover:ring-primary/10'
                    "
                    @click="
                      store.isPaused ? handleResumeLive() : handlePauseLive()
                    "
                  >
                    <MicOff v-if="store.isPaused" class="h-4 w-4" />
                    <Mic v-else class="h-4 w-4" />
                    <span class="sr-only">
                      {{
                        store.isPaused ? "Unmute microphone" : "Mute microphone"
                      }}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {{ store.isPaused ? "Click to unmute" : "Click to mute" }}
                  </p>
                </TooltipContent>
              </Tooltip>

              <!-- Level meter -->
              <div
                class="relative flex h-12 min-w-0 flex-1 items-center overflow-hidden px-1"
              >
                <div class="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    class="h-full rounded-full bg-primary transition-all duration-75"
                    :style="{
                      width: `${Math.min(100, Math.max(0, (store.micLevel / MIC_LEVEL_BAR_MAX) * 100))}%`,
                    }"
                  />
                </div>
              </div>

              <!-- Elapsed time -->
              <span
                v-if="store.liveElapsed != null"
                class="w-[4rem] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground"
              >
                {{ formatDuration(store.liveElapsed) }}
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>

    <div
      v-else
      class="transcription-page relative mx-auto flex min-h-0 w-full flex-1 flex-col bg-muted"
    >
      <div v-if="!store.isProcessing" class="absolute right-5 top-5 z-20">
        <TranscriptionSettingsPanel
          :execution-env="store.executionEnv"
          :effective-runtime="store.effectiveRuntime"
          :is-processing="store.isProcessing"
          :parakeet-cached="store.parakeetCached"
          :sortformer-cached="store.sortformerCached"
          :parakeet-load-progress="store.parakeetLoadProgress"
          :parakeet-indeterminate="store.parakeetLoadIndeterminate"
          :sortformer-load-progress="store.sortformerLoadProgress"
          @update:execution-env="store.setExecutionEnv($event)"
          @clear-cache="handleClearCache"
        />
      </div>

      <ScrollArea class="min-h-0 flex-1">
        <BrowserAdvisoryBanner
          v-if="shouldShowRuntimeAdvisory"
          :variant="advisoryVariant"
        />

        <div v-if="showDropZone" class="mx-auto w-full max-w-3xl px-6 py-10">
          <!-- Browse all saved transcripts (reached via "View all") -->
          <template v-if="isBrowsingHistory">
            <button
              type="button"
              class="mb-5 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              @click="handleBackToNew"
            >
              <ChevronLeft class="h-4 w-4" />
              New transcript
            </button>
            <TranscriptionHistoryList
              :records="historySummaries"
              :is-loading="isLoadingHistory"
              @open="handleOpenRecord"
              @delete="handleDeleteRecord"
              @delete-all="handleDeleteAllRecords"
            />
          </template>

          <template v-else>
            <!-- Headline -->
            <div v-if="!store.liveMode" :class="store.file ? 'mb-8' : 'mb-4'">
              <h1 class="text-2xl font-semibold">
                Turn your recordings into transcripts
              </h1>
              <p class="mt-2 text-sm text-muted-foreground">
                Private, on-device transcription for voice memos and videos.
              </p>
              <div
                v-if="!store.file"
                class="mt-3 flex flex-wrap items-center gap-2"
              >
                <span
                  class="inline-flex items-center rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-muted-foreground"
                >
                  English only
                </span>
                <span
                  class="inline-flex items-center rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-muted-foreground"
                >
                  Detects up to 4 speakers
                </span>
              </div>
            </div>

            <!-- File upload mode (default path) -->
            <template v-if="!store.liveMode">
              <TranscriptionDropZone
                :file="store.file"
                :is-processing="store.isProcessing"
                @file-selected="handleFileSelected"
                @clear="handleClearFile"
              />

              <!-- File selected: settings + start -->
              <div v-if="store.file" class="mt-3">
                <div
                  v-if="store.fileDuration"
                  class="text-xs text-muted-foreground"
                >
                  Duration: {{ formatDuration(store.fileDuration) }}
                </div>
                <div
                  v-if="preflightWarning"
                  class="mt-8 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                >
                  {{ preflightWarning }}
                </div>
                <div
                  class="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-3"
                >
                  <div>
                    <p class="text-sm font-medium">Speaker identification</p>
                    <p class="text-xs text-muted-foreground">
                      Identify and label speakers when possible.
                    </p>
                  </div>
                  <Switch
                    :model-value="store.enableDiarization"
                    @update:model-value="store.setEnableDiarization($event)"
                  />
                </div>
                <Button
                  class="mt-12 h-10 w-full"
                  :disabled="blocksTranscription || isAwaitingPrefetch"
                  @click="handleStartTranscription"
                >
                  <Loader2
                    v-if="isAwaitingPrefetch"
                    class="mr-2 h-4 w-4 animate-spin"
                  />
                  {{ isAwaitingPrefetch ? "Preparing…" : "Transcribe" }}
                </Button>
              </div>

              <!-- No file: secondary live action, privacy note, recents -->
              <template v-else>
                <div class="mt-4 flex items-center justify-between gap-3">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:border-foreground/40 hover:text-foreground"
                    @click="store.setLiveMode(true)"
                  >
                    <Mic class="h-4 w-4" />
                    Record live audio instead
                  </button>
                  <span
                    class="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <ShieldCheck class="h-3.5 w-3.5 shrink-0" />
                    Runs locally, nothing is uploaded
                  </span>
                </div>

                <!-- Recent transcripts -->
                <section
                  v-if="isLoadingHistory || hasHistory"
                  class="mt-8 border-t border-border pt-8"
                >
                  <div class="mb-3 flex items-center justify-between gap-3">
                    <h2 class="text-sm font-semibold text-foreground">
                      Recent transcripts
                    </h2>
                    <div class="flex items-center gap-3">
                      <button
                        v-if="hasMoreHistory"
                        type="button"
                        class="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        @click="handleOpenBrowse"
                      >
                        View all ({{ historySummaries.length }})
                      </button>
                      <ConfirmDestructiveButton
                        v-if="hasHistory"
                        variant="ghost"
                        size="sm"
                        class="flex h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                        armed-class="flex h-7 gap-1.5 px-2 text-xs bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
                        confirm-tooltip-text="Click again to delete all transcripts"
                        @confirm="handleDeleteAllRecords"
                      >
                        <template #default="{ isArmed }">
                          <component
                            :is="isArmed ? Check : Trash2"
                            class="h-3.5 w-3.5"
                          />
                          <span>Delete all</span>
                        </template>
                      </ConfirmDestructiveButton>
                    </div>
                  </div>
                  <div
                    v-if="isLoadingHistory"
                    class="flex items-center justify-center rounded-xl border border-border bg-card py-10 text-muted-foreground"
                  >
                    <Loader2 class="h-5 w-5 animate-spin" />
                  </div>
                  <ul
                    v-else
                    class="overflow-hidden rounded-xl border border-border bg-card"
                  >
                    <li
                      v-for="record in recentSummaries"
                      :key="record.id"
                      class="group/record relative border-b border-border/70 last:border-b-0"
                    >
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 px-4 py-3 pr-20 text-left transition-colors hover:bg-foreground/[0.04]"
                        @click="handleOpenRecord(record.id)"
                      >
                        <span
                          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground"
                        >
                          <Mic v-if="record.isLiveRecording" class="h-4 w-4" />
                          <FileAudio v-else class="h-4 w-4" />
                        </span>
                        <span class="min-w-0 flex-1">
                          <span class="flex items-center gap-2">
                            <span
                              class="min-w-0 truncate text-sm font-medium text-foreground"
                            >
                              {{ record.fileName || "Untitled transcript" }}
                            </span>
                            <span
                              v-if="record.isLiveRecording"
                              class="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                            >
                              Live
                            </span>
                          </span>
                          <span
                            class="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-[11px] text-muted-foreground"
                          >
                            <span class="font-mono">{{
                              formatDate(record.createdAt)
                            }}</span>
                            <span
                              v-if="formatDuration(record.fileDuration)"
                              class="flex items-center gap-1"
                            >
                              <span aria-hidden="true">·</span>
                              <span class="font-mono">{{
                                formatDuration(record.fileDuration)
                              }}</span>
                            </span>
                          </span>
                        </span>
                      </button>
                      <!-- Trailing controls: open chevron stays put; delete fades in beside it -->
                      <div
                        class="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1"
                      >
                        <div
                          class="pointer-events-auto opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/record:opacity-100"
                        >
                          <ConfirmDestructiveButton
                            variant="ghost"
                            size="icon"
                            class="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            armed-class="h-8 w-8 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
                            confirm-tooltip-text="Click again to delete this transcript"
                            @confirm="handleDeleteRecord(record.id)"
                          >
                            <template #default="{ isArmed }">
                              <component
                                :is="isArmed ? Check : Trash2"
                                class="h-4 w-4"
                              />
                              <span class="sr-only">Delete transcript</span>
                            </template>
                          </ConfirmDestructiveButton>
                        </div>
                        <ChevronRight
                          class="h-4 w-4 text-muted-foreground/50"
                        />
                      </div>
                    </li>
                  </ul>
                </section>
              </template>
            </template>

            <!-- Live microphone mode (idle, pre-start) -->
            <template v-else>
              <button
                type="button"
                class="mb-5 mt-6 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                @click="store.setLiveMode(false)"
              >
                <ChevronLeft class="h-4 w-4" />
                Back
              </button>
              <LiveMicrophonePanel
                :is-model-loading="isAwaitingPrefetch"
                :model-load-progress="store.parakeetLoadProgress"
                :selected-mic-id="store.selectedMicId"
                :selected-mic-label="store.selectedMicLabel"
                :available-mics="store.availableMics"
                @select-microphone="handleSelectMicrophone"
                @start="handleStartLive"
                @cancel="handleCancelLivePrefetch"
              />
            </template>
          </template>
        </div>

        <!-- Live microphone: model loading state -->
        <div v-if="showLiveSession" class="mx-auto w-full max-w-5xl px-6 py-8">
          <LiveMicrophonePanel
            :is-model-loading="true"
            :model-load-progress="store.parakeetLoadProgress"
            :selected-mic-id="store.selectedMicId"
            :selected-mic-label="store.selectedMicLabel"
            :available-mics="store.availableMics"
            @cancel="handleCancel"
          />
        </div>

        <TranscriptionProgressPanel
          v-if="isAwaitingPrefetch"
          phase="downloading-model"
          :enable-diarization="true"
          :transcription-progress="prefetchModelProgress"
          :sortformer-load-progress="store.sortformerLoadProgress"
          :cancelable="true"
          @cancel="handleCancelPrefetchWait"
        />

        <TranscriptionProgressPanel
          v-if="
            store.isProcessing &&
            !store.isListening &&
            (!store.liveMode || isReprocessing)
          "
          :phase="store.processPhase"
          :enable-diarization="isReprocessing ? true : store.enableDiarization"
          :transcoding-progress="store.transcodingProgress"
          :vad-progress="store.vadProgress"
          :transcription-progress="store.transcriptionProgress"
          :diarization-progress="store.diarizationProgress"
          :sortformer-load-progress="store.sortformerLoadProgress"
          :cancelable="!isReprocessing"
          @cancel="handleCancel"
        />

        <div
          v-if="showEmptyCompletion"
          class="mx-auto mt-8 max-w-xl rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p class="font-medium">No transcript was produced</p>
          <p class="mt-1 text-xs">
            The model completed but did not return readable transcript segments.
            Try switching runtime in settings or testing with a shorter
            clear-speech clip.
          </p>
        </div>

        <div
          v-if="store.processPhase === 'error' && store.error"
          class="mx-auto mt-8 max-w-xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <p class="font-medium">Transcription failed</p>
          <p class="mt-1 text-xs">{{ store.error.message }}</p>
          <Button
            variant="outline"
            size="sm"
            class="mt-3"
            @click="
              store.clearProcessingState();
              if (store.liveMode) {
                store.clearLiveState();
              } else {
                store.clearFile();
              }
            "
          >
            Try Again
          </Button>
        </div>
      </ScrollArea>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.live-export-shimmer {
  animation: live-export-shimmer 1.1s cubic-bezier(0.22, 1, 0.36, 1) infinite;
}
@keyframes live-export-shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}
</style>
