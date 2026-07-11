import { describe, expect, it } from "vitest";
import { createWavBlobFromPcm } from "./audioUtils.js";

describe("createWavBlobFromPcm", () => {
  it("creates a mono 16-bit PCM WAV blob from Float32 samples", async () => {
    const pcm = new Float32Array([-1, -0.5, 0, 0.5, 1]);
    const blob = createWavBlobFromPcm(pcm, { sampleRate: 16000 });
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const text = new TextDecoder("ascii").decode(buffer);

    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(54);
    expect(text.slice(0, 4)).toBe("RIFF");
    expect(text.slice(8, 12)).toBe("WAVE");
    expect(text.slice(12, 16)).toBe("fmt ");
    expect(text.slice(36, 40)).toBe("data");
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
  });

  it("clamps non-finite and out-of-range samples into signed PCM range", async () => {
    const pcm = new Float32Array([-2, Number.NaN, 2]);
    const blob = createWavBlobFromPcm(pcm, { sampleRate: 8000 });
    const view = new DataView(await blob.arrayBuffer());

    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(32767);
  });
});
