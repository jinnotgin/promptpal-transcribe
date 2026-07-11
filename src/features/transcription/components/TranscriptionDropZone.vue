<script setup>
import { ref, computed } from "vue";
import { Upload, FileAudio, X, FileVideo } from "lucide-vue-next";
import { Button } from "@/components/ui/button";

const ACCEPTED_AUDIO = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/ogg",
  "audio/webm",
];
const ACCEPTED_VIDEO = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
];
const ACCEPTED_TYPES = [...ACCEPTED_AUDIO, ...ACCEPTED_VIDEO];
const ACCEPTED_EXTENSIONS =
  ".mp3,.wav,.m4a,.aac,.flac,.ogg,.webm,.mp4,.mov,.mkv,.avi";

const props = defineProps({
  file: { type: [Object, null], default: null },
  isProcessing: { type: Boolean, default: false },
});

const emit = defineEmits(["fileSelected", "clear"]);

const isDragOver = ref(false);
const fileInputRef = ref(null);

const isVideo = computed(() => {
  if (!props.file) return false;
  return ACCEPTED_VIDEO.includes(props.file.type);
});

const fileSizeLabel = computed(() => {
  if (!props.file) return "";
  const bytes = props.file.size;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
});

function isAcceptedFile(file) {
  if (ACCEPTED_TYPES.includes(file.type)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(`.${ext}`);
}

function handleDrop(e) {
  isDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file && isAcceptedFile(file)) {
    emit("fileSelected", file);
  }
}

function handleFileInput(e) {
  const file = e.target.files?.[0];
  if (file) {
    emit("fileSelected", file);
  }
  if (fileInputRef.value) fileInputRef.value.value = "";
}

function openFilePicker() {
  fileInputRef.value?.click();
}
</script>

<template>
  <div
    class="flex min-h-full flex-col"
    :class="file ? 'p-0' : 'cursor-pointer items-center px-0 py-6'"
    @dragover.prevent="!file && (isDragOver = true)"
    @dragleave.prevent="!file && (isDragOver = false)"
    @drop.prevent="!file && handleDrop($event)"
    @click="!file && openFilePicker()"
  >
    <!-- File selected state -->
    <div
      v-if="file"
      class="flex items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
    >
      <component
        :is="isVideo ? FileVideo : FileAudio"
        class="h-8 w-8 shrink-0 text-muted-foreground"
      />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium">{{ file.name }}</p>
        <p class="text-xs text-muted-foreground">{{ fileSizeLabel }}</p>
      </div>
      <Button
        v-if="!isProcessing"
        variant="ghost"
        size="icon"
        class="h-7 w-7 shrink-0"
        @click="emit('clear')"
      >
        <X class="h-4 w-4" />
      </Button>
    </div>

    <!-- Drop zone -->
    <div
      v-else
      class="flex min-h-[196px] w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 shadow-sm transition-colors"
      :class="
        isDragOver
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-muted-foreground/25 bg-card text-foreground hover:border-muted-foreground/50'
      "
    >
      <Upload
        class="mb-3 h-9 w-9 text-muted-foreground/50"
        :class="{ 'text-primary': isDragOver }"
      />
      <p class="text-base font-semibold">Drop an audio or video file here</p>
      <p class="mt-1 text-sm text-muted-foreground">
        or click to browse. MP3, WAV, M4A, MP4, MOV, and more.
      </p>
    </div>

    <input
      ref="fileInputRef"
      type="file"
      class="hidden"
      :accept="ACCEPTED_EXTENSIONS"
      @change="handleFileInput"
    />
  </div>
</template>
