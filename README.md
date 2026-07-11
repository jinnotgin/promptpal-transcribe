# PromptPal Transcribe

PromptPal Transcribe is a private, browser-local transcription app for audio files, video files,
and live microphone input. Media processing runs in Web Workers and source media is not uploaded to
a transcription backend.

## Routes

- `/` redirects to `/transcribe`
- `/transcribe` starts a new transcription
- `/transcribe/history` browses local transcript history
- `/transcribe/history/:transcriptId` opens a local transcript

## Development

```bash
npm install
npm run dev
```

## Validation

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:boundaries
```

## Privacy and storage

Transcript history and downloaded model assets are stored in IndexedDB for the current browser
origin. A different hostname or port has separate storage, and clearing site data removes both
history and cached models.

The app downloads public model assets from Hugging Face and the FFmpeg WASM runtime from unpkg when
they are not already cached.
