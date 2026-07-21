import { findAudioPartAtTime } from "./transcriptAudioManifest.js";

/**
 * Coordinate absolute seeks across media-part source replacements. The
 * coordinator keeps user playback intent separate from transient HTMLMediaElement
 * pause events caused by `load()`, and makes overlapping waveform seeks
 * latest-request-wins.
 *
 * @param {{
 *   getAudio: () => Pick<HTMLAudioElement, 'paused' | 'currentTime' | 'play'> | null,
 *   getManifest: () => import('./transcriptAudioManifest.js').TranscriptAudioManifest | null,
 *   getActivePartIndex: () => number,
 *   loadPart: (partIndex: number, relativeTime: number, isCurrent: () => boolean) => Promise<boolean>,
 *   onPlayingChange: (playing: boolean) => void,
 * }} options
 */
export function createTranscriptAudioSeekCoordinator(options) {
  let requestSequence = 0;
  let intendsToPlay = false;
  let activeSourceChanges = 0;

  function handleMediaPlay() {
    intendsToPlay = true;
    options.onPlayingChange(true);
  }

  function handleMediaPause() {
    options.onPlayingChange(false);
    if (activeSourceChanges === 0) intendsToPlay = false;
  }

  function setPlaybackIntent(playing) {
    intendsToPlay = Boolean(playing);
  }

  function cancelPendingSeek() {
    requestSequence += 1;
  }

  async function seekAbsolute(absoluteTime) {
    const requestId = ++requestSequence;
    const audio = options.getAudio();
    const manifest = options.getManifest();
    if (!audio) return false;
    if (!manifest) {
      audio.currentTime = Math.max(0, Number(absoluteTime) || 0);
      return true;
    }

    const shouldResume = intendsToPlay || !audio.paused;
    intendsToPlay = shouldResume;
    const target = findAudioPartAtTime(manifest, absoluteTime);
    if (target.partIndex !== options.getActivePartIndex()) {
      return await loadTargetPart(
        target.partIndex,
        target.relativeTime,
        shouldResume,
        requestId,
      );
    }

    audio.currentTime = target.relativeTime;
    if (shouldResume && audio.paused) {
      return await resumeAudio(audio, requestId);
    }
    options.onPlayingChange(!audio.paused);
    return true;
  }

  async function continueToNextPart() {
    const manifest = options.getManifest();
    const nextPartIndex = options.getActivePartIndex() + 1;
    if (!manifest?.parts[nextPartIndex]) {
      cancelPendingSeek();
      intendsToPlay = false;
      options.onPlayingChange(false);
      return false;
    }
    intendsToPlay = true;
    return await loadTargetPart(nextPartIndex, 0, true, ++requestSequence);
  }

  async function loadTargetPart(
    partIndex,
    relativeTime,
    shouldResume,
    requestId,
  ) {
    const isCurrent = () => requestId === requestSequence;
    activeSourceChanges += 1;
    options.onPlayingChange(false);
    let loaded = false;
    try {
      loaded = await options.loadPart(partIndex, relativeTime, isCurrent);
    } finally {
      activeSourceChanges = Math.max(0, activeSourceChanges - 1);
    }
    if (!loaded || !isCurrent()) return false;

    const audio = options.getAudio();
    if (!audio) return false;
    if (shouldResume && audio.paused)
      return await resumeAudio(audio, requestId);
    options.onPlayingChange(!audio.paused);
    return true;
  }

  async function resumeAudio(audio, requestId) {
    try {
      await audio.play();
    } catch {
      if (requestId == null || requestId === requestSequence) {
        intendsToPlay = false;
        options.onPlayingChange(false);
      }
      return false;
    }
    if (requestId != null && requestId !== requestSequence) return false;
    options.onPlayingChange(!audio.paused);
    return !audio.paused;
  }

  return {
    handleMediaPlay,
    handleMediaPause,
    setPlaybackIntent,
    cancelPendingSeek,
    seekAbsolute,
    continueToNextPart,
  };
}
