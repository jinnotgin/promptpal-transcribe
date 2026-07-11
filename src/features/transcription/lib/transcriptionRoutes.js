export const TRANSCRIPTION_ROUTE_NAMES = Object.freeze({
  start: "transcribe",
  history: "transcribe-history",
  detail: "transcribe-history-detail",
});

export function transcriptionStartLocation() {
  return { name: TRANSCRIPTION_ROUTE_NAMES.start };
}

export function transcriptionHistoryLocation() {
  return { name: TRANSCRIPTION_ROUTE_NAMES.history };
}

/**
 * @param {string} transcriptId
 */
export function transcriptionDetailLocation(transcriptId) {
  return {
    name: TRANSCRIPTION_ROUTE_NAMES.detail,
    params: { transcriptId },
  };
}

/**
 * @param {{ name?: unknown, params?: Record<string, unknown> }} route
 * @returns {{ surface: 'start' | 'history' | 'detail' | 'invalid-detail', transcriptId: string | null }}
 */
export function getTranscriptionRouteState(route) {
  if (route.name === TRANSCRIPTION_ROUTE_NAMES.history) {
    return { surface: "history", transcriptId: null };
  }

  if (route.name === TRANSCRIPTION_ROUTE_NAMES.detail) {
    const transcriptId = route.params?.transcriptId;
    if (typeof transcriptId === "string" && transcriptId.length > 0) {
      return { surface: "detail", transcriptId };
    }
    return { surface: "invalid-detail", transcriptId: null };
  }

  return { surface: "start", transcriptId: null };
}
