/**
 * Translate raw exceptions thrown by uww.js / browser APIs into a
 * short, user-friendly description.
 *
 * Returns `{ message, hint? }` where `message` is the headline and
 * `hint` is an optional one-line follow-up with what to do about it.
 *
 * We keep this small and additive — never swallow the original error
 * (the full stack is still in the console).
 */
export interface FriendlyError {
  message: string;
  hint?: string;
}

const HINT_HTTPS =
  'getUserMedia requires HTTPS (or localhost). Open this dashboard ' +
  'over https:// — Nabu Casa, a reverse proxy with TLS, or a self-' +
  'signed cert all work.';

const HINT_PERMISSION =
  'Microphone access was denied. Click the address-bar permission ' +
  "icon, allow microphone access for this site, and reload.";

const HINT_NO_DEVICE =
  'No microphone device was found. Plug in / unmute a mic and reload.';

const HINT_MODEL_FETCH =
  'Could not fetch the wake-word model. Check the manifest_url / ' +
  'model_url and that the file is reachable from this dashboard.';

const HINT_SAMPLE_RATE =
  'Browser ignored the requested 16 kHz audio rate (common on ' +
  'Safari/iOS). Set `strict_sample_rate: false` to proceed with ' +
  'reduced accuracy, or use a different browser.';

export function friendlyError(err: unknown): FriendlyError {
  const raw = err instanceof Error ? err : new Error(String(err));
  const name = raw.name;
  const msg = raw.message ?? '';

  // 1. getUserMedia DOMExceptions.
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // Distinguish HTTPS missing vs permission denied.
    if (!window.isSecureContext) {
      return { message: 'Microphone not available over plain HTTP', hint: HINT_HTTPS };
    }
    return { message: 'Microphone permission denied', hint: HINT_PERMISSION };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { message: 'No microphone found', hint: HINT_NO_DEVICE };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return {
      message: 'Microphone could not be opened',
      hint:
        'Another app or tab may be using the microphone. Close other ' +
        'voice apps and reload.',
    };
  }

  // 2. uww.js sample-rate enforcement.
  if (msg.includes('AudioContext sample rate is')) {
    return { message: 'Audio sample-rate mismatch', hint: HINT_SAMPLE_RATE };
  }

  // 3. fetch failures during model/manifest load.
  //    These usually surface as plain `TypeError: Failed to fetch` or a
  //    "404"/"NetworkError" string from uww.js's manifest loader.
  if (
    /Failed to fetch|NetworkError|404|CORS/i.test(msg) ||
    /manifest|model/i.test(msg)
  ) {
    return { message: 'Could not load wake-word model', hint: HINT_MODEL_FETCH };
  }

  // 4. Fallback — keep the raw message.
  return { message: msg || 'Unexpected error' };
}
