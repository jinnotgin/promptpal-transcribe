<script setup>
import { computed, onBeforeUnmount, ref, useAttrs, watch } from "vue";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

defineOptions({
  inheritAttrs: false,
});

const props = defineProps({
  variant: {
    type: null,
    default: "ghost",
  },
  size: {
    type: null,
    default: "icon",
  },
  class: {
    type: null,
    default: "",
  },
  armedClass: {
    type: String,
    default:
      "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive",
  },
  confirmTooltipText: {
    type: String,
    default: "Click again to confirm",
  },
  armedTimeoutMs: {
    type: Number,
    default: 3000,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  busy: {
    type: Boolean,
    default: false,
  },
  type: {
    type: String,
    default: "button",
  },
  tooltipSide: {
    type: String,
    default: "top",
  },
  tooltipAlign: {
    type: String,
    default: "center",
  },
});

const emit = defineEmits(["confirm"]);
const attrs = useAttrs();

const rootRef = ref(null);
const isArmed = ref(false);
const isTooltipOpen = ref(false);
let armedTimeoutId = null;

const isDisabled = computed(() => props.disabled || props.busy);
const buttonClass = computed(() =>
  cn(props.class, isArmed.value ? props.armedClass : ""),
);

const clearArmedTimeout = () => {
  if (armedTimeoutId !== null) {
    window.clearTimeout(armedTimeoutId);
    armedTimeoutId = null;
  }
};

const resetArmedState = () => {
  clearArmedTimeout();
  isArmed.value = false;
  isTooltipOpen.value = false;
};

const startArmedTimeout = () => {
  clearArmedTimeout();
  armedTimeoutId = window.setTimeout(() => {
    resetArmedState();
  }, props.armedTimeoutMs);
};

const armButton = () => {
  isArmed.value = true;
  isTooltipOpen.value = true;
  startArmedTimeout();
};

const handleClick = (event) => {
  event.stopPropagation();

  if (isDisabled.value) return;

  if (isArmed.value) {
    resetArmedState();
    emit("confirm", event);
    return;
  }

  armButton();
};

const handleTooltipOpenChange = (open) => {
  isTooltipOpen.value = isArmed.value ? open : false;
};

const handleDocumentPointerDown = (event) => {
  if (!isArmed.value) return;
  if (rootRef.value?.contains(event.target)) return;
  resetArmedState();
};

const handleDocumentKeyDown = (event) => {
  if (!isArmed.value) return;
  if (event.key === "Escape") {
    resetArmedState();
  }
};

watch(isArmed, (armed) => {
  if (armed) {
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return;
  }

  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeyDown);
});

watch(
  () => isDisabled.value,
  (disabled) => {
    if (disabled) {
      resetArmedState();
    }
  },
);

onBeforeUnmount(() => {
  resetArmedState();
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeyDown);
});
</script>

<template>
  <span ref="rootRef" class="inline-flex">
    <TooltipProvider :delay-duration="0">
      <Tooltip :open="isTooltipOpen" @update:open="handleTooltipOpenChange">
        <TooltipTrigger asChild>
          <Button
            v-bind="attrs"
            :type="type"
            :variant="variant"
            :size="size"
            :class="buttonClass"
            :disabled="isDisabled"
            @click="handleClick"
          >
            <slot :is-armed="isArmed" :is-busy="busy" />
          </Button>
        </TooltipTrigger>
        <TooltipContent :side="tooltipSide" :align="tooltipAlign">
          <p>{{ confirmTooltipText }}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </span>
</template>
