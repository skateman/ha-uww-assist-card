# uww Assist Card

In-browser **microWakeWord** wake-word detection for Home Assistant
dashboards. On detection, the card opens HA's built-in voice dialog
(`ha-voice-command-dialog`) with auto-listen — Assist's STT / intent /
TTS / `continue_conversation` runs through HA exactly as it does for
the sidebar mic button.

The same `.tflite` model that ESPHome's `micro_wake_word` runs on
your ESP32 satellites works here unchanged, with no extra HA add-on
required. Browser-side detection means zero network traffic until a
wake word fires.

## Features

- Always-on **browser wake-word detection** powered by
  [`uww.js`](https://github.com/skateman/uww.js) (TFLite + a WASM
  build of TFLite-Micro's audio frontend — bit-identical features to
  the model's training pipeline).
- **One-shot model fetch**: manifest + `.tflite` are cached in the
  browser's Cache Storage. Bump `?v=N` on the URL to refresh.
- **Auto-close**: when the AI's reply doesn't ask a follow-up, the
  voice dialog dismisses itself.
- **Audio resampling**: Safari / iOS browsers that ignore the
  requested 16 kHz mic rate get automatic in-process downsampling so
  the same model still works.
- **Multi-tab safe**: a `BroadcastChannel` lease coordinates several
  dashboards / tabs so they don't fight over the microphone.
- **Three display modes**: full card, single-pill compact, or
  invisible (still arms + listens).
- **Wake-detection cue**: short configurable chime/beep so the user
  hears "yes I heard you" before the dialog opens.
- **Visual config editor** with HA's native Assist-pipeline picker.

## Requirements

- Home Assistant **2024.6** or later.
- Dashboard served over **HTTPS** (or `localhost`). Browser
  `getUserMedia` doesn't work over plain HTTP.
- A microWakeWord v2 `.tflite` model (or its JSON manifest). The
  community models at
  [`esphome/micro-wake-word-models`](https://github.com/esphome/micro-wake-word-models)
  work as-is; or train your own.

## Install via HACS

This is a **frontend (Lovelace) plugin** in HACS.

1. HACS → Frontend → menu → **Custom repositories**.
2. Repository URL: `https://github.com/skateman/ha-uww-assist-card`
3. Category: **Dashboard**.
4. Click **Add**, then install. HACS registers the resource for you
   on first install.
5. Hard-refresh the dashboard.

## Configuration

YAML:

```yaml
type: custom:uww-assist-card

# Required
wake_word_url: https://cdn.jsdelivr.net/gh/esphome/micro-wake-word-models@main/models/v2/hey_jarvis.json

# Optional (defaults shown)
pipeline_id: preferred      # "preferred" | "last_used" | <pipeline id>
threshold:                  # default: manifest's probability_cutoff
sliding_window_size:        # default: manifest's sliding_window_size
refractory_ms: 2000
auto_start: false           # arm on card mount (needs prior gesture once)
auto_close: true            # close dialog when intent has no follow-up
display: full               # full | compact | invisible
wake_sound: chime           # chime | beep | none
strict_sample_rate: false   # true → fail instead of resampling on Safari/iOS
companion_app: dialog       # dialog | native
# wasm_path:                # advanced override; defaults to bundled WASM
```

Or use the visual editor (gear icon when adding/editing a card).

### Display modes

- `full` — title, status pill, mic indicator, wake counter, buttons.
- `compact` — a single status pill, click to arm / disarm.
- `invisible` — renders no visible UI; the wake-word loop still runs.

### Wake-word source

`wake_word_url` accepts either a JSON manifest (preferred) or a raw
`.tflite` URL. The extension decides which is which. With a manifest
we read `probability_cutoff` and `sliding_window_size` from it, so
you usually don't need to set `threshold` / `sliding_window_size`
explicitly.

Relative URLs resolve against your HA origin:

```yaml
wake_word_url: /local/wakeword/my_model.json
```

### Audio feedback

`wake_sound` plays a short synth chime on detection so the user
gets feedback before the dialog renders. Pure WebAudio — no asset
to fetch, no extra bundle weight.

### Cache invalidation

The manifest + model bytes are cached in
[`CacheStorage`](https://developer.mozilla.org/en-US/docs/Web/API/CacheStorage).
The cache key is the full URL **including the query string**, so
bumping a version on the manifest URL invalidates both:

```yaml
wake_word_url: /local/wakeword/my_model.json?v=3
```

If the manifest's `model` field is a relative path, the model URL
inherits the same `?v=...` automatically.

## Browser support

| Browser              | Notes                                             |
| -------------------- | ------------------------------------------------- |
| Chrome / Edge        | Full support, native 16 kHz capture.              |
| Firefox              | Full support, native 16 kHz capture.              |
| Safari / iOS         | Works via in-process resampling.                  |
| HA Companion (Android) | Works on Android WebView ≥ 89.                  |
| HA Companion (iOS)   | iOS WKWebView has known `getUserMedia` quirks; YMMV. |

## Same model, multiple devices

The whole point: train (or download) a model once, run it on:

- ESP32 voice satellites via [ESPHome's `micro_wake_word`](https://esphome.io/components/micro_wake_word.html)
- Android tablets via [`mww-satellite`](https://github.com/skateman/mww-satellite)
- Any HA dashboard tab via **this card**

The feature extraction (mel filterbank + PCAN + log scale) is
bit-identical across all three thanks to a vendored copy of
TFLite-Micro's audio frontend.

## Development

```bash
npm install
npm run build       # → dist/ha-uww-assist-card.js + dist/wasm/
npm run typecheck
npm run dev         # watch mode
```

### Releasing

1. Bump `version` in `package.json` on a branch.
2. Merge to `main`.
3. CI tags `v<version>` and publishes a GitHub Release with the
   built `dist/*` artefacts automatically — HACS will pick it up.

## License

MIT — see [LICENSE](LICENSE).
