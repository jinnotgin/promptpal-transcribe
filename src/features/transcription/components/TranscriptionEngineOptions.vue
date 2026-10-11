<script setup>
import { computed } from "vue";
import { LARGE_GROUP_SPEAKERS } from "@/features/transcription/lib/engineSelection.js";

/** @typedef {import('@/features/transcription/lib/engineSelection').EngineSelection} EngineSelection */

const props = defineProps({
  language: { type: String, required: true },
  enableDiarization: { type: Boolean, default: true },
  speakerScale: { type: String, default: "group" },
  speakerCount: { type: Number, default: LARGE_GROUP_SPEAKERS.default },
  showSpeakers: { type: Boolean, default: true },
  /** Live transcription skips the post-ASR word aligner. */
  includeAligner: { type: Boolean, default: true },
  selection: {
    type: /** @type {import('vue').PropType<EngineSelection>} */ (Object),
    required: true,
  },
  chineseAvailable: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits([
  "update:language",
  "update:enableDiarization",
  "update:speakerScale",
  "update:speakerCount",
]);

const languageOptions = computed(() => [
  { value: "en", label: "English", disabled: false },
  {
    value: "zh",
    label: "Chinese + English",
    disabled: !props.chineseAvailable,
  },
]);

const groupLimit = computed(() => {
  const diarization = props.selection.diarization;
  return diarization && "maxSpeakers" in diarization
    ? diarization.maxSpeakers
    : 8;
});
const speakerMode = computed(() =>
  props.enableDiarization
    ? props.speakerScale === "large"
      ? "large"
      : "group"
    : "solo",
);
const speakerOptions = computed(() => [
  { value: "solo", label: "Just me" },
  { value: "group", label: `Group (up to ${groupLimit.value})` },
  { value: "large", label: "Large group" },
]);

/** @param {string} mode */
function selectSpeakerMode(mode) {
  emit("update:enableDiarization", mode !== "solo");
  if (mode !== "solo") emit("update:speakerScale", mode);
}

/** @param {Event} event */
function updateSpeakerCount(event) {
  const value = Number(/** @type {HTMLInputElement} */ (event.target).value);
  if (Number.isFinite(value) && value > 0) emit("update:speakerCount", value);
}

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
  const { asr, diarization, aligner } = props.selection;
  const asrInfo = ASR_SUMMARY[asr.engine];
  const parts = [`${asrInfo.name} (${asrInfo.sizes[asr.variant]})`];
  if (aligner && props.includeAligner) {
    parts.push("Qwen3-ForcedAligner for word timing (1 GB)");
  }
  if (diarization?.engine === "nemotron") {
    parts.push("Nemotron 3 Diarization (120 MB)");
  } else if (diarization?.engine === "sherpa") {
    parts.push("pyannote + CAM++ speaker clustering (34 MB)");
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
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="speakerMode === option.value"
          :disabled="disabled"
          class="rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            speakerMode === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          "
          @click="selectSpeakerMode(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <div
        v-if="speakerMode === 'large'"
        class="flex flex-wrap items-center gap-2 pt-1"
      >
        <label for="transcription-speaker-count" class="text-xs font-medium">
          Number of speakers
        </label>
        <input
          id="transcription-speaker-count"
          type="number"
          inputmode="numeric"
          :min="LARGE_GROUP_SPEAKERS.min"
          :max="LARGE_GROUP_SPEAKERS.max"
          :value="speakerCount"
          :disabled="disabled"
          class="h-7 w-16 rounded-md border border-input bg-background px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          @change="updateSpeakerCount"
        />
      </div>
      <p v-if="speakerMode === 'large'" class="text-xs text-muted-foreground">
        For more than 8 people. Enter how many people talk; labels are less
        reliable than Group, so use Group when 8 or fewer speak.
      </p>
    </div>

    <p class="text-xs text-muted-foreground">{{ engineSummary }}</p>
  </div>
</template>
