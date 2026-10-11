<script setup>
import { X } from "lucide-vue-next";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CHANGELOG, formatReleaseDate } from "./changelog.js";

defineProps({
  version: { type: String, required: true },
});
</script>

<template>
  <Popover>
    <PopoverTrigger
      class="font-mono underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
      aria-label="What's new"
    >
      v{{ version }}
    </PopoverTrigger>
    <PopoverContent
      side="top"
      align="end"
      :side-offset="8"
      class="max-h-[min(32rem,70svh)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-0"
    >
      <div
        class="sticky top-0 flex items-center justify-between border-b border-border bg-popover py-2 pl-4 pr-2"
      >
        <h2 class="text-sm font-medium text-foreground">What's new</h2>
        <PopoverClose
          class="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Close"
        >
          <X class="h-4 w-4" />
        </PopoverClose>
      </div>
      <ol class="divide-y divide-border">
        <li
          v-for="release in CHANGELOG"
          :key="release.version"
          class="space-y-2 px-4 py-3"
        >
          <div class="flex items-baseline gap-2">
            <h3 class="flex items-baseline gap-2 text-sm text-foreground">
              <span class="font-mono text-xs text-muted-foreground"
                >v{{ release.version }}</span
              >
              <span class="font-medium">{{ release.title }}</span>
            </h3>
            <time
              :datetime="release.date"
              class="ml-auto shrink-0 text-[11px] text-muted-foreground/70"
              >{{ formatReleaseDate(release.date) }}</time
            >
          </div>
          <ul
            class="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground marker:text-muted-foreground/60"
          >
            <li v-for="change in release.changes" :key="change.lead">
              <span class="font-medium text-foreground">{{ change.lead }}</span>
              <template v-if="change.detail">{{
                ` ${change.detail}`
              }}</template>
            </li>
          </ul>
        </li>
      </ol>
    </PopoverContent>
  </Popover>
</template>
