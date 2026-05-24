# uww Assist Card

In-browser **microWakeWord** wake-word detection for Home Assistant
dashboards. On detection, the card opens HA's built-in voice dialog
with auto-listen, then auto-dismisses it after the turn.

Same `.tflite` model your ESP32 voice satellites use also works here
— no extra add-on required.

## Features

- Browser-side wake-word detection (no network until detection)
- Auto-close when the AI doesn't ask a follow-up
- Audio resampling fallback for Safari / iOS
- Multi-tab safe (BroadcastChannel mic lease)
- Three display modes: full / compact / invisible
- Configurable wake-detection chime
- Visual config editor

See the README for setup.
