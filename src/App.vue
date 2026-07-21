<script setup>
import { provide } from "vue";
import { RouterView } from "vue-router";
import { Toaster, useToast } from "@/components/ui/toast";
import { APP_NAME, APP_VERSION } from "@/lib/config.js";

const { toast } = useToast();
provide("toast", toast);
</script>

<template>
  <div class="flex h-svh flex-col overflow-hidden bg-muted text-foreground">
    <header
      class="flex h-10 shrink-0 items-center border-b border-border bg-card px-4 sm:px-5"
    >
      <div class="flex min-w-0 items-center gap-2">
        <img
          src="@/assets/app-icon.svg"
          alt=""
          aria-hidden="true"
          class="h-6 w-6 shrink-0"
        />
        <span class="flex min-w-0 items-baseline gap-1.5 truncate text-lg">
          <span class="font-medium text-foreground">{{ APP_NAME }}</span>
          <span class="font-normal text-[hsl(214_72%_46%)]">Transcribe</span>
        </span>
        <span
          class="ml-0.5 shrink-0 rounded border border-foreground/25 px-1 py-0.5 text-[10px] font-medium uppercase leading-none text-muted-foreground"
        >
          Beta
        </span>
      </div>
    </header>
    <main class="flex min-h-0 flex-1 flex-col">
      <RouterView />
    </main>
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
      <span class="font-mono">v{{ APP_VERSION }}</span>
    </footer>
    <Toaster />
  </div>
</template>
