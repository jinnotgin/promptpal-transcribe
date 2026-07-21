const PHASE_TO_STAGE = {
  "checking-cache": "downloading-model",
  "downloading-model": "downloading-model",
  "loading-model": "downloading-model",
  "downloading-diarization-model": "downloading-model",
  "loading-diarization-model": "downloading-model",
  transcoding: "transcribing",
  vad: "transcribing",
  transcribing: "transcribing",
  diarizing: "diarizing",
};

/**
 * Keep the progress panel focused on stable user-visible outcomes rather than
 * the bounded preparation and inference activities repeated within each window.
 * @param {boolean} enableDiarization
 */
export function createProgressStages(enableDiarization) {
  const stages = [
    { key: "downloading-model", label: "Preparing models" },
    { key: "transcribing", label: "Transcribing" },
  ];
  if (enableDiarization) {
    stages.push({ key: "diarizing", label: "Identifying speakers" });
  }
  return stages;
}

/** @param {string} phase */
export function getProgressStageKey(phase) {
  return PHASE_TO_STAGE[phase] || "downloading-model";
}
