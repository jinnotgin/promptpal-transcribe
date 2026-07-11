<script setup>
import { computed } from "vue";
import { Cpu, Zap, ShieldCheck } from "lucide-vue-next";

const props = defineProps({
  runtime: { type: String, required: true },
  webgpuAvailable: { type: Boolean, required: true },
  reason: { type: String, default: "" },
  modelVersion: { type: String, default: "" },
});

const runtimeLabel = computed(() =>
  props.runtime === "webgpu" ? "WebGPU" : "WebAssembly",
);

const runtimeDescription = computed(() =>
  props.runtime === "webgpu"
    ? "Using GPU acceleration for faster transcription."
    : "Using CPU-based inference. Transcription will be slower than WebGPU.",
);
</script>

<template>
  <div
    class="mx-3 mt-3 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm"
    :class="
      runtime === 'webgpu'
        ? 'border-green-200 bg-green-50 text-green-800'
        : 'border-amber-200 bg-amber-50 text-amber-800'
    "
  >
    <component
      :is="runtime === 'webgpu' ? Zap : Cpu"
      class="mt-0.5 h-4 w-4 shrink-0"
    />
    <div class="flex-1">
      <p class="font-medium">
        Runtime: {{ runtimeLabel }}
        <span v-if="modelVersion" class="font-normal opacity-80">
          ({{ modelVersion }})
        </span>
      </p>
      <p class="mt-0.5 text-xs opacity-80">{{ runtimeDescription }}</p>
      <p v-if="reason" class="mt-1 text-xs opacity-80">{{ reason }}</p>
    </div>
    <div
      class="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
      :class="
        runtime === 'webgpu'
          ? 'border-green-300 bg-green-100'
          : 'border-amber-300 bg-amber-100'
      "
    >
      <ShieldCheck class="h-3 w-3" />
      <span>Local only</span>
    </div>
  </div>
</template>
