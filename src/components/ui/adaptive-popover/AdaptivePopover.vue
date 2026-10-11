<script setup>
import { onMounted, ref } from "vue";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Hover reveals the content on mouse/trackpad; touch devices tap to open.
const props = defineProps({
  contentClass: { type: String, default: "w-64 text-xs leading-relaxed" },
  side: { type: String, default: "bottom" },
  align: { type: String, default: "center" },
});

const hasPointerInput = ref(true);

onMounted(() => {
  hasPointerInput.value = window.matchMedia("(pointer: fine)").matches;
});
</script>

<template>
  <TooltipProvider v-if="hasPointerInput" :delay-duration="100">
    <Tooltip disable-closing-trigger>
      <TooltipTrigger as-child>
        <slot name="trigger" />
      </TooltipTrigger>
      <TooltipContent
        :class="['p-3', props.contentClass]"
        :side="props.side"
        :align="props.align"
      >
        <slot />
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <Popover v-else>
    <PopoverTrigger as-child>
      <slot name="trigger" />
    </PopoverTrigger>
    <PopoverContent
      :class="['p-3', props.contentClass]"
      :side="props.side"
      :align="props.align"
      @open-auto-focus.prevent
    >
      <slot />
    </PopoverContent>
  </Popover>
</template>
