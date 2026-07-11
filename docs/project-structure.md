# Project Structure

Imports flow from the shared kernel into the transcription feature and then into routed views.
Workers may import transcription-domain helpers, while feature modules must not import workers
directly.

```text
src/
  app/                     Router and app-level composition
  assets/                  Global styles and brand assets
  components/ui/           Shared UI primitives
  features/transcription/  Components, composables, storage, and pure logic
  lib/                     Standalone shared utilities and configuration
  views/                   Routed composition shells
  workers/                 Heavy processing entrypoints
```

Chat, generation, authentication, and PromptPal backend modules are forbidden dependencies.
