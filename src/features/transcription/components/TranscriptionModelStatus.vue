<script setup>
import { computed } from "vue";
import { CheckCircle2, Download, Circle } from "lucide-vue-next";

const props = defineProps({
  parakeetCached: { type: Boolean, default: false },
  sortformerCached: { type: Boolean, default: false },
  parakeetLoadProgress: { type: Number, default: 0 },
  parakeetIndeterminate: { type: Boolean, default: false },
  sortformerLoadProgress: { type: Number, default: 0 },
});

const parakeetStatus = computed(() => {
  if (props.parakeetCached) return "cached";
  if (
    props.parakeetIndeterminate ||
    (props.parakeetLoadProgress > 0 && props.parakeetLoadProgress < 100)
  )
    return "downloading";
  return "missing";
});

const sortformerStatus = computed(() => {
  if (props.sortformerCached) return "cached";
  if (props.sortformerLoadProgress > 0 && props.sortformerLoadProgress < 100)
    return "downloading";
  return "missing";
});

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
            href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"
            target="_blank"
            rel="noopener noreferrer"
            class="ml-2 break-words text-primary underline-offset-2 hover:underline"
            >NVIDIA Parakeet TDT v3</a
          >
        </p>
      </div>
    </div>

    <div class="flex items-start gap-2">
      <component
        :is="statusIcon(sortformerStatus)"
        class="mt-0.5 h-3.5 w-3.5 shrink-0"
        :class="statusColor(sortformerStatus)"
      />
      <div class="min-w-0">
        <p class="text-xs text-foreground">
          <span class="font-medium">Diarizer model:</span>
          <a
            href="https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1"
            target="_blank"
            rel="noopener noreferrer"
            class="ml-2 break-words text-primary underline-offset-2 hover:underline"
            >NVIDIA Sortformer v2.1</a
          >
        </p>
      </div>
    </div>
  </div>
</template>
