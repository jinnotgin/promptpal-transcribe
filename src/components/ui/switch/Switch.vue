<script setup>
import { computed } from "vue";
import { SwitchRoot, SwitchThumb, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps({
  // Reka-native API
  modelValue: { type: Boolean, required: false },
  defaultValue: { type: Boolean, required: false },
  // Backward-compatible API (legacy Radix-style)
  checked: { type: Boolean, required: false },
  defaultChecked: { type: Boolean, required: false },
  disabled: { type: Boolean, required: false },
  required: { type: Boolean, required: false },
  name: { type: String, required: false },
  id: { type: String, required: false },
  value: { type: String, required: false },
  asChild: { type: Boolean, required: false },
  as: { type: null, required: false },
  class: { type: null, required: false },
});

const emits = defineEmits(["update:modelValue", "update:checked"]);

const delegatedProps = computed(() => {
  const {
    class: _,
    checked,
    defaultChecked,
    modelValue,
    defaultValue,
    ...delegated
  } = props;

  // Prefer explicit Reka props, otherwise map legacy props.
  const resolvedModelValue = modelValue ?? checked;
  const resolvedDefaultValue = defaultValue ?? defaultChecked;

  return {
    ...delegated,
    ...(resolvedModelValue !== undefined
      ? { modelValue: resolvedModelValue }
      : {}),
    ...(resolvedDefaultValue !== undefined
      ? { defaultValue: resolvedDefaultValue }
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
  <SwitchRoot
    v-bind="forwarded"
    @update:model-value="handleUpdateModelValue"
    :class="
      cn(
        'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        props.class,
      )
    "
  >
    <SwitchThumb
      :class="
        cn(
          'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
        )
      "
    />
  </SwitchRoot>
</template>
