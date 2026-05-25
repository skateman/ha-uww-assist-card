import type { HassLite } from './types.js';

/**
 * Plays a TTS response URL returned by `assist_pipeline/run`.
 *
 * Uses `HTMLAudioElement` (the same approach as HA's own voice dialog
 * via `ha-assist-chat`): streams from the URL, no need to fetch the
 * full buffer first, no auth headers required (HA returns a signed
 * temp URL for the TTS file), broad codec support out of the box on
 * mobile browsers.
 *
 * URLs from HA can be either absolute (`http://...`) or path-relative
 * (`/api/tts_proxy/...`); we resolve relatives via `hass.hassUrl()`
 * if available so it works through HA Companion / reverse-proxy
 * setups identically.
 *
 * Resolves on `ended` (or `error` — caller decides whether to chain).
 * The mic gesture from the wake-word enable should already have
 * satisfied autoplay; on mobile browsers without that, `play()` may
 * reject and we resolve early.
 */
export class TtsPlayer {
  private audio: HTMLAudioElement | null = null;

  /** Start playback. Returns a promise that resolves when playback ends. */
  async play(url: string, hass: HassLite | undefined): Promise<void> {
    this.stop();
    const resolved = this.resolveUrl(url, hass);
    const audio = new Audio(resolved);
    audio.preload = 'auto';
    this.audio = audio;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (reason: string) => {
        if (settled) return;
        settled = true;
        // eslint-disable-next-line no-console
        console.debug(`uww-assist-card: TTS playback ${reason}`);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        if (this.audio === audio) this.audio = null;
        resolve();
      };
      const onEnded = () => finish('ended');
      const onError = () => finish('error');
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);
      audio.play().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('uww-assist-card: TTS play() rejected', err);
        finish('play-rejected');
      });
    });
  }

  /** Stop any in-flight playback. Safe to call repeatedly. */
  stop(): void {
    if (!this.audio) return;
    try {
      this.audio.pause();
      this.audio.src = '';
    } catch {
      /* ignore */
    }
    this.audio = null;
  }

  private resolveUrl(url: string, hass: HassLite | undefined): string {
    if (/^https?:\/\//i.test(url)) return url;
    if (hass?.hassUrl) {
      try {
        return hass.hassUrl(url);
      } catch {
        /* fall through */
      }
    }
    return url;
  }
}
