import { onMounted } from "vue";
import { checkHardwareCapabilities } from "@/features/transcription/lib/hardwareCapabilities.js";

/**
 * Probes WebGPU availability and sets runtime detection state on the store.
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useRuntimeDetection(store) {
  onMounted(async () => {
    try {
      const capability = await checkHardwareCapabilities();
      store.setHardwareCapability(capability);
    } catch (err) {
      store.webgpuAvailable = false;
      store.detectedRuntime = "wasm";
      store.detectedModelVersion = "int8";
      store.runtimeReason = `Runtime detection failed: ${err?.message || "unknown error"}. Falling back to WASM/int8.`;
      store.runtimeAdvisory = "hardware";
    }
  });
}
