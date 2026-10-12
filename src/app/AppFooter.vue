<script setup>
import { APP_VERSION } from "@/lib/config.js";
import { formatVersion } from "@/lib/utils.js";
import AppChangelog from "./AppChangelog.vue";
</script>

<!-- Sits at the end of a view's scroll content rather than pinned to the
     window, so it only shows once the reader scrolls to the bottom. -->
<template>
  <footer
    class="flex shrink-0 items-center justify-between border-t border-border bg-card px-4 py-2 text-xs text-muted-foreground sm:px-5"
  >
    <span>
      Made by
      <a
        href="https://itsjin.com"
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >Jin</a
      >
    </span>
    <AppChangelog :version="formatVersion(APP_VERSION)" />
  </footer>
</template>
