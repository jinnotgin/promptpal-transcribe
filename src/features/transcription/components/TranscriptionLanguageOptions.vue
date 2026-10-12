<script setup>
import { computed } from "vue";
import { SegmentedControl } from "@/components/ui/segmented-control";

const props = defineProps({
  /** "en" (Parakeet), or "zh" / "zh-en" (SenseVoice) */
  language: { type: String, default: "en" },
  disabled: { type: Boolean, default: false },
  /** Drop the card frame and keep the control beside the label, for popovers. */
  compact: { type: Boolean, default: false },
});

const emit = defineEmits(["update:language"]);

const languageOptions = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" },
  { value: "zh-en", label: "Mixed" },
];

const descriptions = {
  en: "Best for English-only recordings.",
  zh: "For Chinese-only recordings.",
  "zh-en": "For recordings with both English and Chinese.",
};

const description = computed(
  () => descriptions[props.language] ?? descriptions.en,
);
</script>

<template>
  <div
    :class="{ 'rounded-md border border-border bg-card px-3 py-3': !compact }"
  >
    <div
      class="flex flex-wrap items-center justify-between"
      :class="compact ? 'gap-x-3 gap-y-1' : 'gap-3'"
    >
      <!-- Compact: label and control share the first row, the hint wraps below. -->
      <div :class="compact ? 'contents' : 'min-w-48 flex-1'">
        <p
          id="transcription-language-label"
          class="text-sm font-medium"
          :class="{ 'order-1': compact }"
        >
          Language
        </p>
        <p
          class="text-xs text-muted-foreground"
          :class="{ 'order-3 basis-full': compact }"
        >
          {{ description }}
          <span v-if="language === 'zh'">
            (Has English too?
            <button
              type="button"
              :disabled="disabled"
              class="whitespace-nowrap underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground disabled:pointer-events-none disabled:opacity-50"
              @click="emit('update:language', 'zh-en')"
            >
              Use Mixed</button
            >.)
          </span>
        </p>
      </div>
      <SegmentedControl
        class="shrink-0"
        :class="{ 'order-2': compact }"
        aria-labelledby="transcription-language-label"
        :model-value="language"
        :options="languageOptions"
        :disabled="disabled"
        @update:model-value="emit('update:language', $event)"
      />
    </div>
  </div>
</template>
