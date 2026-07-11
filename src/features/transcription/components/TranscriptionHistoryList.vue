<script setup>
import { computed } from "vue";
import {
  AudioLines,
  Check,
  FileAudio,
  Loader2,
  Mic,
  Trash,
  Trash2,
  Users,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import ConfirmDestructiveButton from "@/components/ConfirmDestructiveButton.vue";
import { formatDate } from "@/lib/utils.js";

const props = defineProps({
  records: {
    /** @type {import('vue').PropType<import('@/features/transcription/lib/transcriptionDb').TranscriptSummary[]>} */
    type: Array,
    default: () => [],
  },
  isLoading: { type: Boolean, default: false },
});

const emit = defineEmits(["open", "delete", "deleteAll"]);

const hasRecords = computed(() => props.records.length > 0);

/**
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const safeSeconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}
</script>

<template>
  <section class="mx-auto w-full max-w-4xl">
    <div class="mb-4 flex items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-foreground">Saved transcripts</h2>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Stored on this device only. Open one to keep working on it.
        </p>
      </div>
      <ConfirmDestructiveButton
        v-if="hasRecords"
        variant="outline"
        size="sm"
        class="flex h-9 shrink-0 gap-2 px-3 text-xs"
        confirm-tooltip-text="Click again to delete all transcripts"
        armed-class="flex h-9 shrink-0 gap-2 px-3 text-xs border-destructive/40 bg-destructive/10 text-destructive hover:border-destructive/50 hover:bg-destructive/20 hover:text-destructive"
        @confirm="emit('deleteAll')"
      >
        <template #default="{ isArmed }">
          <component :is="isArmed ? Check : Trash2" class="h-3.5 w-3.5" />
          <span>Delete all</span>
        </template>
      </ConfirmDestructiveButton>
    </div>

    <!-- Loading -->
    <div
      v-if="isLoading"
      class="flex items-center justify-center rounded-xl border border-border bg-card py-16 text-muted-foreground"
    >
      <Loader2 class="h-5 w-5 animate-spin" />
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!hasRecords"
      class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center"
    >
      <AudioLines class="mb-4 h-10 w-10 text-muted-foreground/50" />
      <p class="text-base font-semibold text-foreground">
        No saved transcripts yet
      </p>
      <p class="mt-1 max-w-sm text-sm text-muted-foreground">
        Transcribe a recording and it will be saved here automatically so you
        can reopen it later.
      </p>
    </div>

    <!-- List -->
    <ul v-else class="overflow-hidden rounded-xl border border-border bg-card">
      <li
        v-for="record in records"
        :key="record.id"
        class="group/record relative border-b border-border/70 last:border-b-0"
      >
        <button
          type="button"
          class="flex w-full items-start gap-3 px-4 py-3.5 pr-14 text-left transition-colors hover:bg-foreground/[0.04]"
          @click="emit('open', record.id)"
        >
          <span
            class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground"
          >
            <Mic v-if="record.isLiveRecording" class="h-4 w-4" />
            <FileAudio v-else class="h-4 w-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2">
              <span
                class="min-w-0 truncate text-sm font-medium text-foreground"
              >
                {{ record.fileName || "Untitled transcript" }}
              </span>
              <span
                v-if="record.isLiveRecording"
                class="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Live
              </span>
            </span>
            <span
              class="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground"
            >
              <span class="font-mono">{{ formatDate(record.createdAt) }}</span>
              <span
                v-if="formatDuration(record.fileDuration)"
                class="flex items-center gap-1"
              >
                <span aria-hidden="true">·</span>
                <span class="font-mono">{{
                  formatDuration(record.fileDuration)
                }}</span>
              </span>
              <span
                v-if="record.speakerCount > 1"
                class="flex items-center gap-1"
              >
                <span aria-hidden="true">·</span>
                <Users class="h-3 w-3" />
                <span class="font-mono">{{ record.speakerCount }}</span>
              </span>
            </span>
            <span
              v-if="record.preview"
              class="mt-1.5 line-clamp-2 text-xs leading-5 text-foreground/70"
            >
              {{ record.preview }}
            </span>
          </span>
        </button>
        <div
          class="absolute right-3 top-3 z-10 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/record:opacity-100"
        >
          <ConfirmDestructiveButton
            variant="ghost"
            size="icon"
            class="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            armed-class="h-8 w-8 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
            confirm-tooltip-text="Click again to delete this transcript"
            @confirm="emit('delete', record.id)"
          >
            <template #default="{ isArmed }">
              <component :is="isArmed ? Check : Trash" class="h-4 w-4" />
              <span class="sr-only">Delete transcript</span>
            </template>
          </ConfirmDestructiveButton>
        </div>
      </li>
    </ul>
  </section>
</template>
