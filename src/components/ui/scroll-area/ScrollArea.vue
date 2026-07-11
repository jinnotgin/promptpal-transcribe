<script setup>
import { ref, computed } from "vue";
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaViewport } from "reka-ui";
import ScrollBar from "./ScrollBar.vue";
import { cn } from "@/lib/utils";

const props = defineProps({
  type: { type: null, required: false },
  dir: { type: null, required: false },
  scrollHideDelay: { type: Number, required: false },
  asChild: { type: Boolean, required: false },
  as: { type: null, required: false },
  class: { type: null, required: false },
});

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props;

  return delegated;
});

const scrollAreaRef = ref(null);

const scrollTop = (value) => {
  const viewport = scrollAreaRef.value;
  if (!viewport) return;

  if (typeof value === "undefined") {
    // Get current scrollTop
    return viewport.scrollTop();
  } else {
    // Set scrollTop
    viewport.scrollTop = value;
  }
};

const scrollTo = (...args) => {
  const viewport = scrollAreaRef.value;
  if (!viewport) return;

  viewport.scrollTo(...args);
};

defineExpose({
  scrollTop,
  scrollTo,
  viewport: () => scrollAreaRef.value?.viewport,
});
</script>

<template>
  <ScrollAreaRoot
    ref="scrollAreaRef"
    v-bind="delegatedProps"
    :class="cn('relative overflow-hidden', props.class)"
  >
    <ScrollAreaViewport class="h-full w-full rounded-[inherit]">
      <slot />
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
