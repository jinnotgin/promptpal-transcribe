<script setup>
import { computed } from "vue";
import { Minus, Plus } from "lucide-vue-next";
import { Switch } from "@/components/ui/switch";
import {
  GROUP_MAX_SPEAKERS,
  LARGE_GROUP_SPEAKERS,
  clampLargeGroupSpeakers,
} from "@/features/transcription/lib/engineSelection.js";

const props = defineProps({
  enabled: { type: Boolean, default: true },
  /** "group" (up to 8) or "large" (more than 8, with a given count) */
  scale: { type: String, default: "group" },
  count: { type: Number, default: LARGE_GROUP_SPEAKERS.default },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(["update:enabled", "update:scale", "update:count"]);

// Up to 8 speakers are found automatically; only larger groups need a count.
const isLarge = computed(() => props.scale === "large");

/** @param {Event} event */
function updateCount(event) {
  const input = /** @type {HTMLInputElement} */ (event.target);
  const value = Number(input.value);
  const count =
    input.value !== "" && Number.isFinite(value)
      ? clampLargeGroupSpeakers(value)
      : props.count;
  // Show the clamped value even when it equals the current prop.
  input.value = String(count);
  emit("update:count", count);
}

/** @param {number} delta */
function stepCount(delta) {
  emit("update:count", clampLargeGroupSpeakers(props.count + delta));
}
</script>

<template>
  <div class="rounded-md border border-border bg-card px-3 py-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p id="speaker-identification-label" class="text-sm font-medium">
          Speaker identification
        </p>
        <p class="text-xs text-muted-foreground">
          Detects and labels up to {{ GROUP_MAX_SPEAKERS }} speakers
          automatically.
        </p>
      </div>
      <Switch
        aria-labelledby="speaker-identification-label"
        :model-value="enabled"
        :disabled="disabled"
        @update:model-value="emit('update:enabled', $event)"
      />
    </div>

    <div v-if="enabled" class="mt-3 space-y-3 border-t border-border pt-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p id="speaker-scale-label" class="text-xs font-medium">
            More than {{ GROUP_MAX_SPEAKERS }} speakers?
          </p>
          <p class="text-xs text-muted-foreground">
            Set how many people speak for an accurate split.
          </p>
        </div>
        <Switch
          aria-labelledby="speaker-scale-label"
          :model-value="isLarge"
          :disabled="disabled"
          @update:model-value="emit('update:scale', $event ? 'large' : 'group')"
        />
      </div>

      <div
        v-if="isLarge"
        class="flex flex-wrap items-center justify-between gap-2"
      >
        <div>
          <label for="speaker-count" class="text-xs font-medium">
            Number of speakers
          </label>
          <p class="text-xs text-muted-foreground">
            {{ LARGE_GROUP_SPEAKERS.min }} to {{ LARGE_GROUP_SPEAKERS.max }}
            people
          </p>
        </div>
        <div
          class="inline-flex h-8 items-center rounded-md border border-input bg-background"
          :class="{ 'opacity-50': disabled }"
        >
          <button
            type="button"
            aria-label="Fewer speakers"
            :disabled="disabled || count <= LARGE_GROUP_SPEAKERS.min"
            class="flex h-full w-8 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            @click="stepCount(-1)"
          >
            <Minus class="h-3.5 w-3.5" />
          </button>
          <input
            id="speaker-count"
            type="number"
            inputmode="numeric"
            :min="LARGE_GROUP_SPEAKERS.min"
            :max="LARGE_GROUP_SPEAKERS.max"
            :value="count"
            :disabled="disabled"
            class="h-full w-10 border-x border-input bg-transparent text-center text-xs font-medium tabular-nums [appearance:textfield] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            @change="updateCount"
          />
          <button
            type="button"
            aria-label="More speakers"
            :disabled="disabled || count >= LARGE_GROUP_SPEAKERS.max"
            class="flex h-full w-8 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            @click="stepCount(1)"
          >
            <Plus class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
