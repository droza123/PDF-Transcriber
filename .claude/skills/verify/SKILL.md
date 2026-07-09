---
name: verify
description: Build, launch, and drive PDFTranscriber to verify changes at the UI surface.
---

# Verifying PDFTranscriber changes

Electron + React 19 + Vite app. AI calls and settings live in the **renderer**; settings persist in `localStorage` under key `app_settings`.

## Build / type-check
- `npm run lint` — tsc --noEmit. Should pass clean.
- `npm run build` — vite build (does NOT run tsc). Chunk-size warnings are pre-existing.

## Launch for browser-driven verification
- `.claude/launch.json` defines `vite-dev` (npm run dev, port 3001). Use `preview_start` with name `vite-dev`.
- The app renders fine in a plain browser for settings/UI work; Electron-only APIs (file dialogs, DOCX workers) are unavailable — don't drive export flows here.
- The preview browser has its own localStorage — no API keys, so conversions can't run; verify settings/model-resolution logic instead.

## Driving tips
- Open settings: `button[title="Settings"]`.
- Beware duplicate text matches: the empty-state cards behind the modal also contain provider names ("Gemini"). Match provider tabs by class (`flex-1 px-3 py-2.5`) or take the last match.
- DOM reads immediately after a programmatic `click()` in the same eval can see pre-render state — read in a separate `preview_eval` call.
- **Gold trick**: Vite serves the real modules, so `await import('/src/lib/settings.ts')` in `preview_eval` calls the exact getters the app uses (e.g. `getScanModelPriority()`), reading real localStorage. This verifies resolution logic end-to-end without an API key.
  - After editing a file, bust the browser's ES-module cache with a query param (`import('/src/lib/foo.ts?v=2')`) — a bare re-import returns the stale cached module.
  - Project files outside `public/` are fetchable in dev via `/@fs/C:/ClaudeCode/PDFTranscriber/<file>` — useful for feeding real book markdown into engine tests.
  - AI stages accept `{provider, models}` — pass a stub provider (`{id, callText: async () => ({text, modelUsed}), isRateLimitError/isPersistentError/isOverloadedError: () => ..., summarizeError, batchDelayMs: 0}`) to drive them deterministically without an API key.
- Inspect persisted state: `JSON.parse(localStorage.getItem('app_settings'))`.
