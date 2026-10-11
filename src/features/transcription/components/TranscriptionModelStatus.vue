<script setup>
import { computed } from "vue";
import { CheckCircle2, Download, Circle } from "lucide-vue-next";

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

const parakeetStatus = computed(() => {
  if (props.parakeetCached) return "cached";
  if (
    props.parakeetIndeterminate ||
    (props.parakeetLoadProgress > 0 && props.parakeetLoadProgress < 100)
  )
    return "downloading";
  return "missing";
});

const diarizerStatus = computed(() => {
  if (props.diarizationCached) return "cached";
  if (props.diarizationLoadProgress > 0 && props.diarizationLoadProgress < 100)
    return "downloading";
  return "missing";
});

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

function statusIcon(status) {
  if (status === "cached") return CheckCircle2;
  if (status === "downloading") return Download;
  return Circle;
}

function statusColor(status) {
  if (status === "cached") return "text-green-600";
  if (status === "downloading") return "text-primary animate-pulse";
  return "text-muted-foreground/40";
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-start gap-2">
      <component
        :is="statusIcon(parakeetStatus)"
        class="mt-0.5 h-3.5 w-3.5 shrink-0"
        :class="statusColor(parakeetStatus)"
      />
      <div class="min-w-0">
        <p class="text-xs text-foreground">
          <span class="font-medium">STT model:</span>
          <a
            :href="asrModel.href"
            target="_blank"
            rel="noopener noreferrer"
            class="ml-2 break-words text-primary underline-offset-2 hover:underline"
            >{{ asrModel.name }}</a
          >
        </p>
      </div>
    </div>

    <div class="flex items-start gap-2">
      <component
        :is="statusIcon(diarizerStatus)"
        class="mt-0.5 h-3.5 w-3.5 shrink-0"
        :class="statusColor(diarizerStatus)"
      />
      <div class="min-w-0">
        <p class="text-xs text-foreground">
          <span class="font-medium">Diarizer model:</span>
          <a
            :href="diarizerModel.href"
            target="_blank"
            rel="noopener noreferrer"
            class="ml-2 break-words text-primary underline-offset-2 hover:underline"
            >{{ diarizerModel.name }}</a
          >
        </p>
      </div>
    </div>
  </div>
</template>
