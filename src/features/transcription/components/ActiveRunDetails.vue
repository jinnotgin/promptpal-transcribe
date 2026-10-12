<script setup>
import TranscriptionModelStatus from "./TranscriptionModelStatus.vue";

defineProps({
  /** Props for TranscriptionModelStatus, set to the run in progress. */
  modelStatus: { type: Object, required: true },
  /** Plain-language hardware name, e.g. "graphics card (WebGPU)". */
  runtimeLabel: { type: String, required: true },
});
</script>

<template>
  <div
    class="space-y-3 rounded-md border border-border bg-muted/40 px-3.5 py-3"
  >
    <div>
      <p class="text-xs font-medium text-foreground">
        What’s running on your device
      </p>
      <p class="mt-0.5 text-xs leading-5 text-muted-foreground">
        These models do the transcribing right here in your browser.
      </p>
    </div>
    <div class="border-t border-border pt-3">
      <TranscriptionModelStatus v-bind="modelStatus" compact />
    </div>
    <p class="border-t border-border pt-3 text-xs text-muted-foreground">
      Processing on your {{ runtimeLabel }}.
    </p>
  </div>
</template>
