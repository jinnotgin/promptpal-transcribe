<script setup>
import { computed } from "vue";

const props = defineProps({
  /** "en" (Parakeet) or "zh-en" (SenseVoice) */
  language: { type: String, default: "en" },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(["update:language"]);

const languageOptions = [
  { value: "en", label: "English" },
  { value: "zh-en", label: "English + 中文" },
];

const description = computed(() =>
  props.language === "zh-en"
    ? "Mandarin, English, or both mixed together."
    : "Fastest and most accurate for English-only audio.",
);
</script>

<template>
  <div class="rounded-md border border-border bg-card px-3 py-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p id="transcription-language-label" class="text-sm font-medium">
          Language
        </p>
        <p class="text-xs text-muted-foreground">{{ description }}</p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="transcription-language-label"
        class="inline-flex gap-1 rounded-md bg-muted p-1"
      >
        <button
          v-for="option in languageOptions"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="language === option.value"
          :disabled="disabled"
          class="rounded px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            language === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          "
          @click="emit('update:language', option.value)"
        >
          {{ option.label }}
        </button>
      </div>
    </div>
  </div>
</template>
