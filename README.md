# shhsaid

_What's said stays here._

shhsaid is a private, browser-local transcription app for audio files, video files, and live
microphone input, in English or English and Chinese. Media processing runs in Web Workers and
source media is not uploaded to a transcription backend.

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

## Deployment

Set `VITE_SITE_URL` to the public site address when building so social previews (Open Graph and
Twitter cards) use absolute URLs for the share image:

```bash
VITE_SITE_URL=https://example.com npm run build
```

Without it, the share tags use relative paths, which most social platforms ignore.

The build leaves out ONNX Runtime's WASM binaries (24-28 MB each), which keeps every file under
static hosts' size limits such as Cloudflare Pages' 25 MiB. The app loads them from jsDelivr at
runtime instead; see `scripts/dropOrtWasm.js`.

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

The app downloads public model assets from Hugging Face, the ONNX Runtime WASM runtime from
jsDelivr, and the FFmpeg WASM runtime from unpkg when they are not already cached. A
Content-Security-Policy or network filter must allow all three.
