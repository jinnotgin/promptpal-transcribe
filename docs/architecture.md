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

`lib/engineSelection.js` picks models from the chosen language, speaker mode, and runtime tier.
Variants follow Parakeet's tiers so memory stays comparable.

| Choice            | WebGPU tier                                                     | WASM tier                                                |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| English           | Parakeet TDT v3 fp16 (~1.2 GB)                                  | Parakeet int8 (~640 MB)                                  |
| Chinese + English | Qwen3-ASR 0.6B q4f16 (~880 MB), q4 without shader-f16 (~1.3 GB) | Not offered (CPU decoding is 2-4x slower than real time) |
| Group speakers    | Nemotron 3 Diarization int8 (120 MB, up to 8 speakers)          | Same model on WASM                                       |
| Large group       | pyannote segmentation 3.0 + CAM++ (34 MB, user-given 2-26)      | Same models (always WASM)                                |
| Chinese timing    | Qwen3-ForcedAligner 0.6B q4 (~1 GB), after ASR                  | Not offered (Chinese needs WebGPU)                       |

The legacy Sortformer v2.1 diarizer (469 MB, up to 4 speakers) stays selectable for English in
settings.

- English transcribes first, then assigns speakers to Parakeet's word timestamps.
- Qwen3-ASR has no word timestamps, so Chinese with speakers diarizes first: Nemotron produces
  speaker turns, and `lib/qwenAsrRegions.js` cuts VAD regions at those turns (max 30 s) before
  ASR. Chinese text is stored without English-style spaces.
- Large group ports sherpa-onnx's offline pyannote pipeline (`lib/sherpaDiarizer.js`): 10 s
  segmentation chunks every 1 s, a CAM++ embedding per local speaker, then complete-linkage
  clustering into the number of speakers the user enters. It runs incrementally, holding one
  chunk of audio. It has no speaker cap but confuses speakers more than Nemotron, so Group stays
  the default. CAM++ runs on WASM: on WebGPU its embeddings drift (cosine ~0.91), which merges
  similar voices. Speaker labels run A-Z, hence the cap of 26.
- Chinese transcripts get real character and word timings from Qwen3-ForcedAligner after ASR.
  Qwen3-ASR is unloaded first, the committed audio is re-read, and each ASR region (max 30 s)
  is aligned in one forward pass. If alignment fails the proportional timings are kept. Live
  transcription keeps proportional timings.
- Nemotron and Qwen workers import `onnxruntime-web/webgpu`; the default bundle's WebGPU backend
  returns wrong values for these graphs in onnxruntime-web 1.30.
- Models are cached in IndexedDB as 64 MB chunks because some Chromium builds reject larger
  values. Downloads are written chunk by chunk as they arrive; prefetch keeps no copy, so a 1 GB
  model does not need 2 GB of page memory.

`scripts/fixtures/` regenerates the Nemotron and Qwen parity fixtures from the Hugging Face
`transformers` reference implementations, the sherpa fbank and clustering fixtures from
`kaldi-native-fbank` and `sherpa-onnx`, and the aligner text fixtures from `qwen-asr`.
