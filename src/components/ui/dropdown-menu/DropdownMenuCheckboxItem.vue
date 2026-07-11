<script setup>
import { computed } from "vue";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItemIndicator,
  useForwardPropsEmits,
} from "reka-ui";
import { Check } from "lucide-vue-next";
import { cn } from "@/lib/utils";

const props = defineProps({
  // Reka-native API
  modelValue: { type: null, required: false },
  // Backward-compatible API (legacy Radix-style)
  checked: { type: null, required: false },
  disabled: { type: Boolean, required: false },
  textValue: { type: String, required: false },
  asChild: { type: Boolean, required: false },
  as: { type: null, required: false },
  class: { type: null, required: false },
});
const emits = defineEmits(["select", "update:modelValue", "update:checked"]);

const delegatedProps = computed(() => {
  const { class: _, checked, modelValue, ...delegated } = props;

  return {
    ...delegated,
    ...(modelValue !== undefined
      ? { modelValue }
      : checked !== undefined
        ? { modelValue: checked }
        : {}),
  };
});

const forwarded = useForwardPropsEmits(delegatedProps, emits);

const handleUpdateModelValue = (value) => {
  emits("update:modelValue", value);
  emits("update:checked", value);
};
</script>

<template>
  <DropdownMenuCheckboxItem
    v-bind="forwarded"
    @update:model-value="handleUpdateModelValue"
    :class="
      cn(
        'relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        props.class,
      )
    "
  >
    <span class="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuItemIndicator>
        <Check class="w-4 h-4" />
      </DropdownMenuItemIndicator>
    </span>
    <slot />
  </DropdownMenuCheckboxItem>
</template>
