const LIVE_RECORDING_PROFILES = [
  { mimeType: "audio/webm;codecs=opus" },
  { mimeType: "audio/ogg;codecs=opus" },
  { mimeType: "audio/mp4;codecs=mp4a.40.2" },
  { mimeType: "audio/mp4" },
];

/**
 * Choose by browser capability only. Persist the recorder's actual mimeType
 * after construction because browsers may normalize the requested value.
 */
export function selectLiveRecordingProfile() {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    throw new Error(
      "This browser does not support compressed microphone recording. Use a current desktop browser.",
    );
  }
  const profile = LIVE_RECORDING_PROFILES.find(({ mimeType }) =>
    MediaRecorder.isTypeSupported(mimeType),
  );
  if (!profile) {
    throw new Error(
      "This browser cannot create a supported local audio recording. Try current Chrome, Firefox, or Safari on desktop.",
    );
  }
  return { ...profile };
}
