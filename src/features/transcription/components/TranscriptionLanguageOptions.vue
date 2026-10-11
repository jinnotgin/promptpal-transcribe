<script setup>
import { computed } from "vue";
import { SegmentedControl } from "@/components/ui/segmented-control";

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
      <SegmentedControl
        aria-labelledby="transcription-language-label"
        :model-value="language"
        :options="languageOptions"
        :disabled="disabled"
        @update:model-value="emit('update:language', $event)"
      />
    </div>
  </div>
</template>
