<script setup>
import { computed } from "vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeRuntime } from "@/features/transcription/lib/onDeviceInfo.js";

const props = defineProps({
  /** "auto" | "webgpu" | "wasm" */
  modelValue: { type: String, required: true },
  effectiveRuntime: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(["update:modelValue"]);

const runtimeLabel = computed(() =>
  describeRuntime(props.modelValue, props.effectiveRuntime),
);
</script>

<template>
  <div class="space-y-2">
    <Select
      :model-value="modelValue"
      :disabled="disabled"
      @update:model-value="emit('update:modelValue', $event)"
    >
      <SelectTrigger class="h-9 text-sm" aria-label="Transcription runtime">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Automatic</SelectItem>
        <SelectItem value="webgpu">Graphics card (WebGPU)</SelectItem>
        <SelectItem value="wasm">Processor (WebAssembly)</SelectItem>
      </SelectContent>
    </Select>
    <p v-if="modelValue === 'auto'" class="text-xs text-muted-foreground">
      Using your {{ runtimeLabel }}.
    </p>
  </div>
</template>
