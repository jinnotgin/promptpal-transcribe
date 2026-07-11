import { describe, expect, it } from "vitest";
import {
  SYSTEM_DEFAULT_MIC_ID,
  createSystemDefaultMic,
  reconcileMicrophoneDevices,
} from "./useMicrophoneDevices.js";

describe("reconcileMicrophoneDevices", () => {
  it("always includes System default before browser devices", () => {
    const result = reconcileMicrophoneDevices({
      devices: [
        {
          kind: "audioinput",
          deviceId: "built-in",
          label: "Built-in Microphone",
        },
        { kind: "videoinput", deviceId: "camera", label: "Camera" },
      ],
      selectedMicId: SYSTEM_DEFAULT_MIC_ID,
      previousMics: [],
    });

    expect(result.availableMics).toEqual([
      createSystemDefaultMic(),
      {
        deviceId: "built-in",
        label: "Built-in Microphone",
        available: true,
        isSystemDefault: false,
      },
    ]);
    expect(result.selectedMicAvailable).toBe(true);
    expect(result.selectedMicLabel).toBe("System default");
  });

  it("uses stable fallback labels when browser labels are hidden", () => {
    const result = reconcileMicrophoneDevices({
      devices: [
        { kind: "audioinput", deviceId: "device-1", label: "" },
        { kind: "audioinput", deviceId: "device-2", label: "" },
      ],
      selectedMicId: "device-2",
      previousMics: [],
    });

    expect(result.availableMics.map((mic) => mic.label)).toEqual([
      "System default",
      "Microphone 1",
      "Microphone 2",
    ]);
    expect(result.selectedMicLabel).toBe("Microphone 2");
    expect(result.selectedMicAvailable).toBe(true);
  });

  it("marks a previously selected missing microphone unavailable", () => {
    const result = reconcileMicrophoneDevices({
      devices: [
        {
          kind: "audioinput",
          deviceId: "built-in",
          label: "Built-in Microphone",
        },
      ],
      selectedMicId: "airpods",
      previousMics: [
        createSystemDefaultMic(),
        {
          deviceId: "airpods",
          label: "AirPods Microphone",
          available: true,
          isSystemDefault: false,
        },
      ],
    });

    expect(result.selectedMicAvailable).toBe(false);
    expect(result.selectedMicLabel).toBe("AirPods Microphone");
    expect(result.availableMics).toContainEqual({
      deviceId: "airpods",
      label: "AirPods Microphone",
      available: false,
      isSystemDefault: false,
    });
  });

  it("does not interrupt when only a non-selected microphone disappears", () => {
    const result = reconcileMicrophoneDevices({
      devices: [
        {
          kind: "audioinput",
          deviceId: "built-in",
          label: "Built-in Microphone",
        },
      ],
      selectedMicId: "built-in",
      previousMics: [
        createSystemDefaultMic(),
        {
          deviceId: "built-in",
          label: "Built-in Microphone",
          available: true,
          isSystemDefault: false,
        },
        {
          deviceId: "usb",
          label: "USB Microphone",
          available: true,
          isSystemDefault: false,
        },
      ],
    });

    expect(result.selectedMicAvailable).toBe(true);
    expect(result.selectedMicLabel).toBe("Built-in Microphone");
    expect(result.availableMics.some((mic) => mic.deviceId === "usb")).toBe(
      false,
    );
  });
});
