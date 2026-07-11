<script setup>
import { computed } from "vue";
import { Settings2, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import TranscriptionModelStatus from "./TranscriptionModelStatus.vue";

const props = defineProps({
  executionEnv: { type: String, required: true },
  effectiveRuntime: { type: String, required: true },
  isProcessing: { type: Boolean, default: false },
  parakeetCached: { type: Boolean, default: false },
  sortformerCached: { type: Boolean, default: false },
  parakeetLoadProgress: { type: Number, default: 0 },
  parakeetIndeterminate: { type: Boolean, default: false },
  sortformerLoadProgress: { type: Number, default: 0 },
});

const emit = defineEmits(["update:executionEnv", "clearCache"]);

const runtimeDisplay = computed(() => {
  if (props.executionEnv === "auto") {
    return `Auto (${props.effectiveRuntime === "webgpu" ? "WebGPU" : "WebAssembly"})`;
  }
  return props.executionEnv === "webgpu" ? "WebGPU" : "WebAssembly (CPU)";
});
</script>

<template>
  <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="icon" class="h-8 w-8">
        <Settings2 class="h-4 w-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-80" align="end">
      <div class="space-y-4">
        <h4 class="text-sm font-medium">Transcription Settings</h4>

        <!-- Model status -->
        <div class="space-y-2">
          <Label class="text-xs">Models</Label>
          <TranscriptionModelStatus
            :parakeet-cached="parakeetCached"
            :sortformer-cached="sortformerCached"
            :parakeet-load-progress="parakeetLoadProgress"
            :parakeet-indeterminate="parakeetIndeterminate"
            :sortformer-load-progress="sortformerLoadProgress"
          />
        </div>

        <!-- Runtime selector -->
        <div class="space-y-2">
          <Label class="text-xs">Execution Runtime</Label>
          <Select
            :model-value="executionEnv"
            :disabled="isProcessing"
            @update:model-value="emit('update:executionEnv', $event)"
          >
            <SelectTrigger class="h-8 text-xs">
              <SelectValue :placeholder="runtimeDisplay" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="webgpu">WebGPU</SelectItem>
              <SelectItem value="wasm">WebAssembly (CPU)</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            Active: {{ runtimeDisplay }}
          </p>
        </div>

        <!-- Clear cache -->
        <div class="border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            class="h-7 w-full text-xs"
            :disabled="isProcessing"
            @click="emit('clearCache')"
          >
            <Trash2 class="mr-1.5 h-3 w-3" />
            Clear Model Cache
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
