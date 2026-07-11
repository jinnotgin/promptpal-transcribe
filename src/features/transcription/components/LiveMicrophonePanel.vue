<script setup>
import { computed } from "vue";
import { Check, ChevronDown, Mic, Loader2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const props = defineProps({
  isModelLoading: { type: Boolean, default: false },
  modelLoadProgress: { type: Number, default: 0 },
  selectedMicId: { type: String, default: "system-default" },
  selectedMicLabel: { type: String, default: "System default" },
  availableMics: { type: Array, default: () => [] },
});

const emit = defineEmits(["start", "cancel", "select-microphone"]);

const statusText = computed(() => {
  if (props.isModelLoading) return "Preparing model...";
  return "Ready";
});
const microphoneOptions = computed(
  () =>
    /** @type {Array<{ deviceId: string, label: string, available: boolean }>} */ (
      props.availableMics
    ),
);
</script>

<template>
  <div
    class="flex min-h-[300px] w-full max-w-5xl flex-col items-center justify-center"
  >
    <!-- Pre-start state -->
    <div
      v-if="!isModelLoading"
      class="flex w-full max-w-md flex-col items-center gap-9 rounded-xl border bg-card px-8 py-10 shadow-sm"
    >
      <div
        class="flex h-24 w-24 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/25"
      >
        <Mic class="h-10 w-10 text-muted-foreground/50" />
      </div>
      <div class="pt-1 text-center">
        <p class="text-base font-semibold">Transcribe from your microphone</p>
        <p class="mt-1 text-sm text-muted-foreground">
          Speak and see your words transcribed in real-time.
        </p>
      </div>
      <div class="flex w-full max-w-sm flex-col items-stretch gap-2">
        <p class="text-left text-xs font-medium text-muted-foreground">
          Microphone input
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              class="h-11 w-full justify-start gap-2.5 rounded-md px-4 text-sm"
            >
              <Mic class="h-4 w-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-left">{{
                selectedMicLabel
              }}</span>
              <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" class="w-72">
            <DropdownMenuItem
              v-for="mic in microphoneOptions"
              :key="mic.deviceId"
              class="flex min-w-0 cursor-pointer items-center gap-2"
              :disabled="!mic.available"
              @click="emit('select-microphone', mic.deviceId)"
            >
              <Check
                class="h-3.5 w-3.5 shrink-0"
                :class="
                  mic.deviceId === selectedMicId ? 'opacity-100' : 'opacity-0'
                "
              />
              <span class="min-w-0 flex-1 truncate">{{ mic.label }}</span>
              <span
                v-if="!mic.available"
                class="shrink-0 text-[10px] text-destructive"
              >
                Unavailable
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Button class="mt-1 h-11 px-8" @click="emit('start')">
        <Mic class="mr-2 h-4 w-4" />
        Start Recording
      </Button>
    </div>

    <!-- Model loading state -->
    <div
      v-else
      class="flex w-full max-w-md flex-col items-center gap-6 rounded-xl border bg-card px-8 py-10 shadow-sm"
    >
      <div
        class="flex h-20 w-20 items-center justify-center rounded-full bg-muted/50"
      >
        <Loader2 class="h-8 w-8 animate-spin text-primary" />
      </div>
      <div class="flex flex-col items-center gap-2">
        <span class="text-sm font-medium">{{ statusText }}</span>
        <p class="text-xs text-muted-foreground">
          Please wait while the transcription model loads.
        </p>
      </div>
      <div
        v-if="modelLoadProgress > 0"
        class="h-2.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
      >
        <div
          class="h-full rounded-full bg-primary transition-all duration-300"
          :style="{ width: `${Math.min(100, modelLoadProgress)}%` }"
        />
      </div>
      <Button variant="outline" size="sm" @click="emit('cancel')"
        >Cancel</Button
      >
    </div>
  </div>
</template>
