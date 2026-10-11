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

## Transcription engines

`lib/engineSelection.js` picks models from the speaker setting and runtime tier.

| Choice                | WebGPU tier                                                | WASM tier                 |
| --------------------- | ---------------------------------------------------------- | ------------------------- |
| Transcription         | Parakeet TDT v3 fp16 (~1.2 GB)                             | Parakeet int8 (~640 MB)   |
| Speakers: up to 8     | Nemotron 3 Diarization int8 (120 MB)                       | Same model on WASM        |
| Speakers: more than 8 | pyannote segmentation 3.0 + CAM++ (34 MB, user-given 9-26) | Same models (always WASM) |

- Speaker identification runs after transcription and assigns speakers to Parakeet's word
  timestamps.
- More than 8 ports sherpa-onnx's offline pyannote pipeline (`lib/sherpaDiarizer.js`): 10 s
  segmentation chunks every 1 s, a CAM++ embedding per local speaker, then complete-linkage
  clustering into the number of speakers the user enters. It runs incrementally, holding one
  chunk of audio. It has no speaker cap but confuses speakers more than Nemotron, so up to 8
  stays the default. CAM++ runs on WASM: on WebGPU its embeddings drift (cosine ~0.91), which
  merges similar voices. Speaker labels run A-Z, hence the cap of 26.
- The Nemotron worker imports `onnxruntime-web/webgpu`; the default bundle's WebGPU backend
  returns wrong values for this graph in onnxruntime-web 1.30.
- Models are cached in IndexedDB as 64 MB chunks because some Chromium builds reject larger
  values. Downloads are written chunk by chunk as they arrive; prefetch keeps no copy.

`scripts/fixtures/` regenerates the Nemotron parity fixtures from the Hugging Face `transformers`
reference implementation, and the sherpa fbank and clustering fixtures from `kaldi-native-fbank`
and `sherpa-onnx`.
