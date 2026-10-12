<script setup>
import { computed } from "vue";
import { CheckCircle2, Circle, Download } from "lucide-vue-next";
import { describeModelStatus } from "@/features/transcription/lib/onDeviceInfo.js";

const props = defineProps({
  /** The speech-to-text engine the current language setting uses. */
  asrEngine: {
    type: /** @type {import('vue').PropType<'parakeet' | 'sensevoice'>} */ (
      String
    ),
    default: "parakeet",
  },
  /** The diarizer the current speaker setting uses. */
  diarizationEngine: {
    type: /** @type {import('vue').PropType<'nemotron' | 'sherpa'>} */ (String),
    default: "nemotron",
  },
  parakeetCached: { type: Boolean, default: false },
  diarizationCached: { type: Boolean, default: false },
  parakeetLoadProgress: { type: Number, default: 0 },
  parakeetIndeterminate: { type: Boolean, default: false },
  diarizationLoadProgress: { type: Number, default: 0 },
});

const asrModel = computed(() =>
  props.asrEngine === "sensevoice"
    ? {
        name: "SenseVoice Small",
        href: "https://huggingface.co/FunAudioLLM/SenseVoiceSmall",
      }
    : {
        name: "NVIDIA Parakeet TDT v3",
        href: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3",
      },
);

const asrStatus = computed(() =>
  describeModelStatus({
    cached: props.parakeetCached,
    progress: props.parakeetLoadProgress,
    indeterminate: props.parakeetIndeterminate,
  }),
);

const diarizerStatus = computed(() =>
  describeModelStatus({
    cached: props.diarizationCached,
    progress: props.diarizationLoadProgress,
  }),
);

const DIARIZER_LINKS = {
  nemotron: {
    name: "NVIDIA Nemotron 3 Diarization",
    href: "https://huggingface.co/nvidia/Nemotron-3-Diarization",
  },
  sherpa: {
    name: "sherpa-onnx pyannote + CAM++",
    href: "https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html",
  },
};

const diarizerModel = computed(
  () => DIARIZER_LINKS[props.diarizationEngine] ?? DIARIZER_LINKS.nemotron,
);

const models = computed(() => [
  { role: "Speech to text", ...asrModel.value, status: asrStatus.value },
  {
    role: "Speaker detection",
    ...diarizerModel.value,
    status: diarizerStatus.value,
  },
]);

/** @param {string} state */
function statusIcon(state) {
  if (state === "ready") return CheckCircle2;
  if (state === "downloading") return Download;
  return Circle;
}

/** @param {string} state */
function statusColor(state) {
  if (state === "ready") return "text-green-600";
  if (state === "downloading") return "text-primary animate-pulse";
  return "text-muted-foreground/40";
}
</script>

<template>
  <ul class="space-y-3">
    <li v-for="model in models" :key="model.role" class="flex gap-2.5">
      <component
        :is="statusIcon(model.status.state)"
        class="mt-0.5 h-4 w-4 shrink-0"
        :class="statusColor(model.status.state)"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <a
          :href="model.href"
          target="_blank"
          rel="noopener noreferrer"
          class="block text-sm font-medium leading-5 text-foreground underline-offset-2 hover:underline"
          >{{ model.name }}</a
        >
        <p class="mt-0.5 text-xs text-muted-foreground">
          {{ model.role
          }}<template v-if="model.status.label">
            <span aria-hidden="true" class="mx-1 text-muted-foreground/50"
              >·</span
            ><span
              :class="{
                'text-primary': model.status.state === 'downloading',
              }"
              >{{ model.status.label }}</span
            ></template
          >
        </p>
      </div>
    </li>
  </ul>
</template>
