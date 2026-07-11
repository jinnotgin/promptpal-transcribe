import { saveAs } from "file-saver";
import {
  formatMarkdown,
  formatPlainText,
  formatSrt,
  transcriptBaseName,
} from "@/features/transcription/lib/transcriptFormatters.js";

/**
 * @param {import('@/features/transcription/stores/transcriptionStore').TranscriptionStore} store
 */
export function useTranscriptionExport(store) {
  /**
   * @param {'txt' | 'md' | 'srt'} format
   */
  function exportTranscript(format) {
    const segments = store.displaySegments;
    const baseName = transcriptBaseName(store.fileName);
    const content =
      format === "srt"
        ? formatSrt(segments)
        : format === "md"
          ? formatMarkdown(segments)
          : formatPlainText(segments);
    const mime =
      format === "md"
        ? "text/markdown"
        : format === "srt"
          ? "application/x-subrip"
          : "text/plain";

    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    saveAs(blob, `${baseName}.${format}`);
  }

  return { exportTranscript };
}
