import { describe, expect, it } from "vitest";
import {
  describeModelStatus,
  describeRuntime,
} from "@/features/transcription/lib/onDeviceInfo.js";

describe("describeRuntime", () => {
  it("names the graphics card when WebGPU is active", () => {
    expect(describeRuntime("auto", "webgpu")).toBe("graphics card (WebGPU)");
  });

  it("names the processor when WebAssembly is active", () => {
    expect(describeRuntime("auto", "wasm")).toBe("processor (WebAssembly)");
  });

  it("follows a manual choice over the detected runtime", () => {
    expect(describeRuntime("wasm", "webgpu")).toBe("processor (WebAssembly)");
    expect(describeRuntime("webgpu", "wasm")).toBe("graphics card (WebGPU)");
  });
});

describe("describeModelStatus", () => {
  it("leaves a ready model unlabelled, since its icon says so", () => {
    expect(describeModelStatus({ cached: true, progress: 40 })).toEqual({
      state: "ready",
      label: "",
    });
  });

  it("reports download progress as a whole percentage", () => {
    expect(describeModelStatus({ cached: false, progress: 41.6 })).toEqual({
      state: "downloading",
      label: "Loading 42%",
    });
  });

  it("reports an indeterminate download without a percentage", () => {
    expect(
      describeModelStatus({ cached: false, progress: 0, indeterminate: true }),
    ).toEqual({ state: "downloading", label: "Loading…" });
  });

  it("explains that a missing model downloads on first use", () => {
    expect(describeModelStatus({ cached: false, progress: 0 })).toEqual({
      state: "missing",
      label: "Downloads on first use",
    });
    expect(describeModelStatus({ cached: false, progress: 100 })).toEqual({
      state: "missing",
      label: "Downloads on first use",
    });
  });
});
