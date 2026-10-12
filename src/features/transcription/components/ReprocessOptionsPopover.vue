<script setup>
import { RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import SpeakerIdentificationOptions from "@/features/transcription/components/SpeakerIdentificationOptions.vue";
import TranscriptionLanguageOptions from "@/features/transcription/components/TranscriptionLanguageOptions.vue";

defineProps({
  open: { type: Boolean, default: false },
  language: { type: String, default: "en" },
  enableDiarization: { type: Boolean, default: true },
  speakerScale: { type: String, default: "group" },
  speakerCount: { type: Number, required: true },
});

const emit = defineEmits([
  "update:open",
  "update:language",
  "update:enableDiarization",
  "update:speakerScale",
  "update:speakerCount",
  "reprocess",
]);
</script>

<template>
  <Popover :open="open" @update:open="emit('update:open', $event)">
    <PopoverTrigger asChild>
      <slot name="trigger" />
    </PopoverTrigger>
    <PopoverContent
      align="end"
      avoid-collisions
      :collision-padding="16"
      class="w-80 p-0"
    >
      <div class="px-4 pb-3 pt-4">
        <p class="text-sm font-medium">Reprocess recording</p>
        <p class="text-xs text-muted-foreground">
          Run this recording again for better accuracy.
        </p>
      </div>
      <div class="divide-y divide-border border-t border-border px-4">
        <TranscriptionLanguageOptions
          compact
          class="py-3"
          :language="language"
          @update:language="emit('update:language', $event)"
        />
        <SpeakerIdentificationOptions
          compact
          class="py-3"
          :enabled="enableDiarization"
          :scale="speakerScale"
          :count="speakerCount"
          @update:enabled="emit('update:enableDiarization', $event)"
          @update:scale="emit('update:speakerScale', $event)"
          @update:count="emit('update:speakerCount', $event)"
        />
      </div>
      <div class="flex justify-end gap-2 border-t border-border px-4 py-3">
        <Button
          size="sm"
          variant="ghost"
          class="h-8 px-3 text-xs"
          @click="emit('update:open', false)"
        >
          Cancel
        </Button>
        <Button size="sm" class="h-8 px-3 text-xs" @click="emit('reprocess')">
          <RefreshCw class="mr-1.5 h-3 w-3" />
          Reprocess
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
