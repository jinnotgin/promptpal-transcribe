<script setup>
import { provide } from "vue";
import { RouterView } from "vue-router";
import { Toaster, useToast } from "@/components/ui/toast";
import { APP_NAME, APP_VERSION } from "@/lib/config.js";

const { toast } = useToast();
provide("toast", toast);
</script>

<template>
  <div class="min-h-svh bg-muted text-foreground">
    <header
      class="flex h-[72px] items-center justify-between border-b border-border bg-card px-5"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        <img
          src="@/assets/app-icon.svg"
          alt=""
          aria-hidden="true"
          class="h-8 w-8 shrink-0"
        />
        <div class="min-w-0">
          <p class="truncate text-base font-semibold">
            {{ APP_NAME }} Transcribe
          </p>
          <p class="text-xs text-muted-foreground">
            Private, local transcription
          </p>
        </div>
      </div>
      <span class="font-mono text-xs text-muted-foreground"
        >v{{ APP_VERSION }}</span
      >
    </header>
    <main>
      <RouterView />
    </main>
    <Toaster />
  </div>
</template>
