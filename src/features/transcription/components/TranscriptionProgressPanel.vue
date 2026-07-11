<script setup>
import { computed } from "vue";
import { Loader2, X, CheckCircle2, Circle } from "lucide-vue-next";
import { Button } from "@/components/ui/button";

const props = defineProps({
  phase: { type: String, required: true },
  enableDiarization: { type: Boolean, default: true },
  transcodingProgress: { type: Number, default: 0 },
  vadProgress: { type: Number, default: 0 },
  transcriptionProgress: { type: Number, default: 0 },
  diarizationProgress: { type: Number, default: 0 },
  sortformerLoadProgress: { type: Number, default: 0 },
  cancelable: { type: Boolean, default: true },
});

const emit = defineEmits(["cancel"]);

const stages = computed(() => {
  const base = [
    { key: "downloading-model", label: "Preparing models" },
    { key: "transcoding", label: "Preparing audio" },
    { key: "vad", label: "Detecting speech" },
    { key: "transcribing", label: "Transcribing" },
  ];
  if (props.enableDiarization) {
    base.push({ key: "diarizing", label: "Identifying speakers" });
  }
  return base;
});

const currentStageIndex = computed(() => {
  const phaseToStage = {
    "checking-cache": "downloading-model",
    "downloading-model": "downloading-model",
    "loading-model": "downloading-model",
    "downloading-diarization-model": "downloading-model",
    "loading-diarization-model": "downloading-model",
    transcoding: "transcoding",
    vad: "vad",
    transcribing: "transcribing",
    diarizing: "diarizing",
  };
  const targetKey = phaseToStage[props.phase];
  const idx = stages.value.findIndex((stage) => stage.key === targetKey);
  return idx === -1 ? 0 : idx;
});

const currentStage = computed(() => stages.value[currentStageIndex.value]);

const currentStageDetail = computed(() => {
  if (props.phase === "checking-cache") return "Preparing models";
  if (props.phase === "loading-model") return "Loading models from cache";
  if (props.phase === "downloading-model") return "Downloading models";
  if (props.phase === "downloading-diarization-model")
    return "Downloading speaker model";
  if (props.phase === "loading-diarization-model")
    return "Loading speaker model from cache";
  if (props.phase === "diarizing") {
    return props.diarizationProgress > 0
      ? "Identifying speakers"
      : "Preparing to identify speakers";
  }
  return currentStage.value?.label || "";
});

const modelPreparationNote = computed(() => {
  if (props.phase === "downloading-model") {
    return "The transcription models are being downloaded to this browser. This is a one-time setup for this browser and can take a while, so keep this tab open.";
  }
  if (props.phase === "downloading-diarization-model") {
    return "The speaker identification model is being downloaded. This is a one-time setup for this browser.";
  }
  return "";
});

const currentProgress = computed(() => {
  // Diarization model download phases use their own progress source
  if (
    props.phase === "downloading-diarization-model" ||
    props.phase === "loading-diarization-model"
  ) {
    return props.sortformerLoadProgress;
  }
  const progressMap = {
    "downloading-model": props.transcriptionProgress,
    transcoding: props.transcodingProgress,
    vad: props.vadProgress,
    transcribing: props.transcriptionProgress,
    diarizing: props.diarizationProgress,
  };
  return progressMap[currentStage.value?.key] ?? 0;
});

function stageState(index) {
  if (index < currentStageIndex.value) return "complete";
  if (index === currentStageIndex.value) return "active";
  return "pending";
}
</script>

<template>
  <div
    class="mx-auto mt-10 w-full max-w-xl rounded-xl border bg-card p-6 shadow-sm"
  >
    <div class="mb-4 flex items-center gap-3">
      <Loader2 class="h-5 w-5 animate-spin text-primary" />
      <div class="min-w-0 flex-1">
        <p class="text-base font-semibold">{{ currentStage?.label }}</p>
        <p class="text-sm text-muted-foreground">
          Stage {{ currentStageIndex + 1 }} of {{ stages.length }}
        </p>
      </div>
      <Button
        v-if="cancelable"
        variant="ghost"
        size="icon"
        class="h-7 w-7"
        @click="emit('cancel')"
      >
        <X class="h-4 w-4" />
      </Button>
    </div>

    <!-- Active stage progress bar -->
    <div class="mb-5 space-y-1">
      <div class="flex items-center justify-between text-sm">
        <span class="text-foreground">{{ currentStageDetail }}</span>
        <span class="text-muted-foreground">
          {{ Math.round(currentProgress) }}%
        </span>
      </div>
      <div class="h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full bg-primary transition-all duration-300"
          :style="{ width: `${currentProgress}%` }"
        />
      </div>
      <div
        v-if="modelPreparationNote"
        class="mt-4 rounded-md border px-4 py-3 text-sm leading-6"
        :class="
          phase === 'downloading-model' ||
          phase === 'downloading-diarization-model'
            ? 'border-primary/30 bg-primary/10 text-foreground'
            : 'border-border bg-muted/40 text-muted-foreground'
        "
      >
        <p class="font-medium text-foreground">
          {{
            phase === "downloading-model" ||
            phase === "downloading-diarization-model"
              ? "First-time setup"
              : "Local cache"
          }}
        </p>
        <p class="mt-1">{{ modelPreparationNote }}</p>
      </div>
    </div>

    <!-- Stage indicator: complete / active / pending dots -->
    <ol class="flex flex-col gap-2">
      <li
        v-for="(stage, index) in stages"
        :key="stage.key"
        class="flex items-center gap-2 text-xs"
      >
        <CheckCircle2
          v-if="stageState(index) === 'complete'"
          class="h-4 w-4 text-green-600"
        />
        <Loader2
          v-else-if="stageState(index) === 'active'"
          class="h-4 w-4 animate-spin text-primary"
        />
        <Circle v-else class="h-4 w-4 text-muted-foreground/40" />
        <span
          :class="
            stageState(index) === 'pending'
              ? 'text-muted-foreground/60'
              : stageState(index) === 'active'
                ? 'font-medium text-foreground'
                : 'text-muted-foreground'
          "
        >
          {{ stage.label }}
        </span>
      </li>
    </ol>

    <p class="mt-5 border-t pt-4 text-xs leading-5 text-muted-foreground">
      This transcription is running locally on your computer. Larger files can
      take a while, and your computer may use more CPU or memory until it's
      done.
    </p>
  </div>
</template>
