import { onMounted, onUnmounted } from "vue";

export const SYSTEM_DEFAULT_MIC_ID = "system-default";

/**
 * @typedef {object} MicrophoneDevice
 * @property {string} deviceId
 * @property {string} label
 * @property {boolean} available
 * @property {boolean} isSystemDefault
 */

/** @returns {MicrophoneDevice} */
export function createSystemDefaultMic() {
  return {
    deviceId: SYSTEM_DEFAULT_MIC_ID,
    label: "System default",
    available: true,
    isSystemDefault: true,
  };
}

/**
 * @param {object} params
 * @param {Array<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>>} params.devices
 * @param {string | null | undefined} params.selectedMicId
 * @param {MicrophoneDevice[]} [params.previousMics]
 * @returns {{
 *   availableMics: MicrophoneDevice[],
 *   selectedMicId: string,
 *   selectedMicLabel: string,
 *   selectedMicAvailable: boolean,
 * }}
 */
export function reconcileMicrophoneDevices({
  devices,
  selectedMicId,
  previousMics = [],
}) {
  const normalizedSelectedId = selectedMicId || SYSTEM_DEFAULT_MIC_ID;
  const previousById = new Map(previousMics.map((mic) => [mic.deviceId, mic]));
  const audioInputs = devices.filter((device) => device.kind === "audioinput");

  const mics = [
    createSystemDefaultMic(),
    ...audioInputs.map((device, index) => ({
      deviceId: device.deviceId,
      label:
        device.label ||
        previousById.get(device.deviceId)?.label ||
        `Microphone ${index + 1}`,
      available: true,
      isSystemDefault: false,
    })),
  ];

  const selectedMic = mics.find((mic) => mic.deviceId === normalizedSelectedId);
  if (selectedMic) {
    return {
      availableMics: mics,
      selectedMicId: normalizedSelectedId,
      selectedMicLabel: selectedMic.label,
      selectedMicAvailable: true,
    };
  }

  const previousSelected = previousById.get(normalizedSelectedId);
  const unavailableSelected = {
    deviceId: normalizedSelectedId,
    label: previousSelected?.label || "Selected microphone",
    available: false,
    isSystemDefault: false,
  };

  return {
    availableMics: [...mics, unavailableSelected],
    selectedMicId: normalizedSelectedId,
    selectedMicLabel: unavailableSelected.label,
    selectedMicAvailable: false,
  };
}

/**
 * Keeps the transcription store in sync with browser microphone devices.
 *
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 * @param {object} [options]
 * @param {MediaDevices} [options.mediaDevices]
 */
export function useMicrophoneDevices(store, options = {}) {
  const mediaDevices =
    options.mediaDevices || globalThis.navigator?.mediaDevices;

  async function refreshMicrophones() {
    if (!mediaDevices?.enumerateDevices) {
      store.setMicrophoneDevices({
        availableMics: [createSystemDefaultMic()],
        selectedMicId: store.selectedMicId,
        selectedMicLabel: "System default",
        selectedMicAvailable: true,
      });
      return;
    }

    const devices = await mediaDevices.enumerateDevices();
    const result = reconcileMicrophoneDevices({
      devices,
      selectedMicId: store.selectedMicId,
      previousMics: store.availableMics,
    });
    store.setMicrophoneDevices(result);
  }

  function handleDeviceChange() {
    void refreshMicrophones();
  }

  onMounted(() => {
    void refreshMicrophones();
    mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);
  });

  onUnmounted(() => {
    mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
  });

  return { refreshMicrophones };
}
