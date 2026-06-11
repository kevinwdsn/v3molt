# Live Translate

A real-time translation web app running on a Cloudflare Worker. Speak (or type) and see
your words translated live into up to five languages at once — including Uzbek, Russian,
Haitian Creole, Malayalam, and 40 more.

## How it works

```
Browser                          Cloudflare Worker
┌──────────────────────┐        ┌─────────────────────────────┐
│ SpeechRecognition    │  text  │ POST /api/translate         │
│ (live mic transcript)│ ─────▶ │  1. Anthropic API (Claude)  │
│ or typed input       │        │  2. Workers AI (m2m100)     │
│                      │ ◀───── │     fallback, no key needed │
│ speechSynthesis      │  JSON  └─────────────────────────────┘
│ (spoken playback)    │
└──────────────────────┘
```

- **Live speech**: continuous browser speech recognition with interim results. Partial
  utterances are translated on a short debounce so translations appear *while you speak*;
  finalized utterances are committed to the conversation history.
- **Multi-target**: one spoken sentence can be broadcast into up to 5 languages in a
  single request (useful for mixed-language audiences).
- **Spoken playback**: each translation has a 🔊 button (and an optional auto-speak mode)
  using the browser's text-to-speech voices.
- **Typing mode**: works everywhere, including browsers without speech recognition, and
  supports automatic source-language detection.

## Translation backends

| Backend | When used | Notes |
|---|---|---|
| Anthropic API (`claude-opus-4-8` by default) | `ANTHROPIC_API_KEY` is set | Best quality, all languages, multi-target in one request, auto language detection. Set `TRANSLATE_MODEL=claude-haiku-4-5` for lower latency/cost. |
| Workers AI (`@cf/meta/m2m100-1.2b`) | No API key, `AI` binding available | No key required (Workers AI free tier applies). One model call per target language; source defaults to English when set to auto. |

## Local development

```bash
npm install
cp live-translate/.dev.vars.example live-translate/.dev.vars
# edit live-translate/.dev.vars with your ANTHROPIC_API_KEY (optional)
npm run translate:dev
```

Then open the printed localhost URL. Microphone access requires `localhost` or HTTPS.

## Deploy

```bash
npx wrangler secret put ANTHROPIC_API_KEY --config live-translate/wrangler.jsonc
npm run translate:deploy
```

The worker deploys as `live-translate` (separate from the main `v3molt` worker).

## API

### `POST /api/translate`

```json
{
  "text": "Good morning, how are you feeling today?",
  "targets": ["uz", "ht", "ml"],
  "source": "en",        // optional, "auto" (default) detects
  "partial": false        // true for interim speech fragments
}
```

Response:

```json
{
  "detected_source": "en",
  "translations": {
    "uz": "Xayrli tong, bugun o'zingizni qanday his qilyapsiz?",
    "ht": "Bonjou, kijan ou santi ou jodi a?",
    "ml": "സുപ്രഭാതം, ഇന്ന് നിങ്ങൾക്ക് എങ്ങനെ തോന്നുന്നു?"
  },
  "backend": "anthropic",
  "partial": false
}
```

### `GET /api/languages`

Returns the supported language catalog (code, English name, native name, speech-recognition
tag, RTL flag).

### `GET /api/health`

Returns which translation backend is active.

## Browser support notes

- **Speech recognition** uses the Web Speech API (`SpeechRecognition`), supported in
  Chrome, Edge, and Safari. Recognition language support varies by browser — widely-spoken
  languages (English, Russian, Spanish, Hindi, …) work well; for languages the browser
  cannot recognize (often Haitian Creole or Uzbek), use the typing mode. Translation
  *into* any supported language always works.
- **Text-to-speech** voice availability also varies by OS/browser; the 🔊 button uses the
  best matching installed voice.

## Tests

Unit tests for validation, prompt construction, and response parsing run with the repo
test suite:

```bash
npm test
```
