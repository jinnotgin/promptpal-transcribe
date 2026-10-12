<script setup>
import { computed } from "vue";
import { Settings, ShieldCheck, Trash2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
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
import { describeRuntime } from "@/features/transcription/lib/onDeviceInfo.js";
import TranscriptionModelStatus from "./TranscriptionModelStatus.vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  /** Give the icon button an outline, for use in page content. */
  outlined: { type: Boolean, default: false },
  executionEnv: { type: String, required: true },
  asrEngine: {
    type: /** @type {import('vue').PropType<'parakeet' | 'sensevoice'>} */ (
      String
    ),
    default: "parakeet",
  },
  diarizationEngine: {
    type: /** @type {import('vue').PropType<'nemotron' | 'sherpa'>} */ (String),
    default: "nemotron",
  },
  effectiveRuntime: { type: String, required: true },
  isProcessing: { type: Boolean, default: false },
  parakeetCached: { type: Boolean, default: false },
  diarizationCached: { type: Boolean, default: false },
  parakeetLoadProgress: { type: Number, default: 0 },
  parakeetIndeterminate: { type: Boolean, default: false },
  diarizationLoadProgress: { type: Number, default: 0 },
});

const emit = defineEmits(["update:open", "update:executionEnv", "clearCache"]);

const runtimeLabel = computed(() =>
  describeRuntime(props.executionEnv, props.effectiveRuntime),
);
</script>

<template>
  <Popover :open="open" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        class="text-muted-foreground hover:text-foreground"
        :class="
          outlined
            ? 'h-9 w-9 border border-border hover:border-foreground/30 hover:bg-transparent'
            : 'h-9 w-9 sm:h-8 sm:w-8'
        "
        aria-label="Settings"
      >
        <Settings class="h-4 w-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="w-[min(20rem,calc(100vw-2rem))] p-0"
      @open-auto-focus.prevent
    >
      <div class="flex items-start gap-2.5 px-4 pb-3 pt-4">
        <ShieldCheck class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div>
          <p class="text-sm font-medium">Nothing leaves this device</p>
          <p class="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Audio is transcribed here, not on a server. Recordings and
            transcripts are saved only in this browser.
          </p>
        </div>
      </div>

      <div class="space-y-5 border-t border-border px-4 py-4">
        <div class="space-y-3">
          <h3
            class="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
          >
            Models
          </h3>
          <TranscriptionModelStatus
            :asr-engine="asrEngine"
            :diarization-engine="diarizationEngine"
            :parakeet-cached="parakeetCached"
            :diarization-cached="diarizationCached"
            :parakeet-load-progress="parakeetLoadProgress"
            :parakeet-indeterminate="parakeetIndeterminate"
            :diarization-load-progress="diarizationLoadProgress"
          />
        </div>

        <div class="space-y-2">
          <h3
            class="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
          >
            Processing
          </h3>
          <Select
            :model-value="executionEnv"
            :disabled="isProcessing"
            @update:model-value="emit('update:executionEnv', $event)"
          >
            <SelectTrigger
              class="h-9 text-sm"
              aria-label="Transcription runtime"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="webgpu">Graphics card (WebGPU)</SelectItem>
              <SelectItem value="wasm">Processor (WebAssembly)</SelectItem>
            </SelectContent>
          </Select>
          <p
            v-if="executionEnv === 'auto'"
            class="text-xs text-muted-foreground"
          >
            Using your {{ runtimeLabel }}.
          </p>
        </div>
      </div>

      <div class="border-t border-border px-4 py-3">
        <Button
          variant="outline"
          size="sm"
          class="h-8 w-full text-xs"
          :disabled="isProcessing"
          @click="emit('clearCache')"
        >
          <Trash2 class="mr-1.5 h-3 w-3" />
          Remove all downloaded models
        </Button>
        <p class="mt-1.5 text-center text-[11px] text-muted-foreground">
          Transcripts stay. Models re-download when needed.
        </p>
      </div>
    </PopoverContent>
  </Popover>
</template>
