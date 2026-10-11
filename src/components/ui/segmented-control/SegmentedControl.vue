<script setup>
import { cn } from "@/lib/utils";

defineProps({
  modelValue: { type: String, required: true },
  options: {
    type: /** @type {import('vue').PropType<Array<{ value: string, label: string }>>} */ (
      Array
    ),
    required: true,
  },
  disabled: { type: Boolean, default: false },
  class: { type: null, required: false },
});

const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <div
    role="radiogroup"
    :class="
      cn(
        'inline-flex gap-0.5 rounded-md border border-input bg-muted p-0.5',
        $props.class,
      )
    "
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === option.value"
      :disabled="disabled"
      :class="
        cn(
          'rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          modelValue === option.value
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-background hover:text-foreground',
        )
      "
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
