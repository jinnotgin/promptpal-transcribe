<script setup>
import { computed } from "vue";

/** @typedef {import('@/features/transcription/lib/engineSelection').EngineSelection} EngineSelection */

const props = defineProps({
  language: { type: String, required: true },
  enableDiarization: { type: Boolean, default: true },
  showSpeakers: { type: Boolean, default: true },
  selection: {
    type: /** @type {import('vue').PropType<EngineSelection>} */ (Object),
    required: true,
  },
  chineseAvailable: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(["update:language", "update:enableDiarization"]);

const languageOptions = computed(() => [
  { value: "en", label: "English", disabled: false },
  {
    value: "zh",
    label: "Chinese + English",
    disabled: !props.chineseAvailable,
  },
]);

const maxSpeakers = computed(
  () => props.selection.diarization?.maxSpeakers ?? 8,
);
const speakerOptions = computed(() => [
  { value: false, label: "Just me" },
  { value: true, label: `Group (up to ${maxSpeakers.value})` },
]);

const ASR_SUMMARY = {
  parakeet: {
    name: "Parakeet TDT v3",
    sizes: { fp16: "1.2 GB", int8: "640 MB" },
  },
  "qwen3-asr": {
    name: "Qwen3-ASR 0.6B",
    sizes: { q4f16: "880 MB", q4: "1.3 GB" },
  },
};

const engineSummary = computed(() => {
  const { asr, diarization } = props.selection;
  const asrInfo = ASR_SUMMARY[asr.engine];
  const parts = [`${asrInfo.name} (${asrInfo.sizes[asr.variant]})`];
  if (diarization?.engine === "nemotron") {
    parts.push("Nemotron 3 Diarization (120 MB)");
  } else if (diarization) {
    parts.push("Sortformer v2.1 (470 MB)");
  }
  return `Models: ${parts.join(" + ")}, downloaded once and cached on this device.`;
});
</script>

<template>
  <div class="space-y-4 rounded-md border border-border bg-card px-3 py-3">
    <div class="space-y-1.5">
      <p id="transcription-language-label" class="text-sm font-medium">
        Language
      </p>
      <div
        role="radiogroup"
        aria-labelledby="transcription-language-label"
        class="inline-flex flex-wrap gap-1 rounded-md bg-muted p-1"
      >
        <button
          v-for="option in languageOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="language === option.value"
          :disabled="disabled || option.disabled"
          class="rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            language === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          "
          @click="emit('update:language', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <p v-if="!chineseAvailable" class="text-xs text-muted-foreground">
        Chinese needs WebGPU. Use desktop Chrome or Edge to enable it.
      </p>
    </div>

    <div v-if="showSpeakers" class="space-y-1.5">
      <p id="transcription-speakers-label" class="text-sm font-medium">
        Speakers
      </p>
      <div
        role="radiogroup"
        aria-labelledby="transcription-speakers-label"
        class="inline-flex flex-wrap gap-1 rounded-md bg-muted p-1"
      >
        <button
          v-for="option in speakerOptions"
          :key="String(option.value)"
          type="button"
          role="radio"
          :aria-checked="enableDiarization === option.value"
          :disabled="disabled"
          class="rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            enableDiarization === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          "
          @click="emit('update:enableDiarization', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>

    <p class="text-xs text-muted-foreground">{{ engineSummary }}</p>
  </div>
</template>
