# Architecture

PromptPal Transcribe is a Vue 3 single-page app with a transcription domain, a minimal shared UI
kernel, and dedicated Web Worker entrypoints.

```text
app/router + views -> features/transcription -> lib + components/ui
                              ^
                           workers
```

- `src/app/` owns public routing.
- `src/views/` composes routed work surfaces.
- `src/features/transcription/` owns transcription UI, state, pipelines, storage, and pure helpers.
- `src/components/ui/` contains the minimum shared UI primitives required by Transcribe.
- `src/lib/` contains standalone configuration, utilities, and the disabled analytics boundary.
- `src/workers/` contains ASR, diarization, FFmpeg, file VAD, and live VAD workers.

All transcripts and model caches are browser-local and scoped to the current origin.
