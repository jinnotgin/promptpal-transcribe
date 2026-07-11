<script setup>
import { computed } from "vue";
import { AlertTriangle } from "lucide-vue-next";

const props = defineProps({
  variant: {
    type: String,
    default: "browser",
    validator: (value) =>
      typeof value === "string" &&
      ["browser", "memory", "browser-memory"].includes(value),
  },
});

const copy = computed(() => {
  if (props.variant === "browser-memory") {
    return {
      title: "This device may not have enough memory",
      body: "Local transcription may fail on this device or browser. For best results, switch to Google Chrome on a desktop or laptop.",
    };
  }
  if (props.variant === "memory") {
    return {
      title: "This device may not have enough memory",
      body: "Local transcription may fail on this device or browser. For best results, switch to Google Chrome on a desktop or laptop.",
    };
  }
  return {
    title: "For best performance, switch to Google Chrome.",
    body: "Transcription in this browser may be significantly slower or less reliable. Google Chrome on a desktop or laptop is recommended.",
  };
});
</script>

<template>
  <div
    class="mx-3 mt-3 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
  >
    <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
    <div class="flex-1">
      <p class="font-medium">{{ copy.title }}</p>
      <p class="mt-0.5 text-xs opacity-80">{{ copy.body }}</p>
    </div>
  </div>
</template>
