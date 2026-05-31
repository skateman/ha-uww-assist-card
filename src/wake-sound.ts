/**
 * Audible feedback cues for the wake → STT → think → speak → end
 * lifecycle of a single Assist turn.
 *
 * Each stage has a fixed cue (the v0.0.9 user-tuned set):
 *
 *   - **Wake detected** — `ding` (ascending two-note E5 → A5). Reads
 *     as "I heard you, go ahead". Fires the moment microWakeWord
 *     triggers.
 *   - **STT listening (post-wake)** — _silent_. The wake `ding`
 *     already told the user the mic is open; a second cue ~100 ms
 *     later overlaps unpleasantly on small kiosk speakers.
 *   - **Thinking** — `soft` (quiet single 660 Hz). Fires the moment
 *     STT closes and HA starts intent processing, so the user knows
 *     the model heard them and is now working on a reply.
 *   - **Session end** — `bloop` (downward pitch glide 880 → 440 Hz).
 *     Reads as "all done, going back to idle".
 *
 * Cues are intentionally not user-selectable per-stage: the v0.0.7
 * experiment showed that letting users mix-and-match produced
 * unpleasant overlaps. The {@link WakeSoundName} config is now only
 * a global on/off — `'default'` plays the fixed set, `'none'` mutes
 * every cue. The global volume multiplier is controlled by
 * `cue_volume` in the card config (see {@link setCueVolume}).
 *
 * Playback uses `HTMLAudioElement` with a `data:audio/wav;base64,…`
 * source as the primary path (best autoplay characteristics on
 * backgrounded Android WebViews). WebAudio is the fallback if
 * `audio.play()` rejects.
 */

/**
 * User-facing config value.  We keep this as a union (rather than a
 * boolean) for backward compatibility with v0.0.7 configs that
 * specified `wake_sound: 'chime'` / `'beep'` — any value other than
 * `'none'` is treated as `'default'`.
 */
export type WakeSoundName = 'default' | 'none' | string;

function silenced(name: WakeSoundName): boolean {
  return name === 'none';
}

interface ToneSpec {
  /** Start time within the cue, seconds. */
  start: number;
  /** Duration of this tone, seconds. */
  dur: number;
  /** Start (and, if no {@link freqEnd}, constant) frequency, Hz. */
  freq: number;
  /**
   * If set, the frequency is linearly swept from {@link freq} to
   * `freqEnd` over the tone's duration (glissando / pitch glide).
   */
  freqEnd?: number;
  /** Peak amplitude before per-tone envelope, 0..1. */
  peak: number;
}

interface CueSpec {
  tones: ToneSpec[];
  /** Total cue duration including envelope tails, seconds. */
  total: number;
}

/** Sample rate for generated WAVs. 22.05 kHz is plenty for ≤4 kHz tones. */
const SAMPLE_RATE = 22050;

/** Default attack / release applied to every tone, seconds. Cosine-shaped. */
const ATTACK = 0.030;
const RELEASE = 0.060;

// ── Cue designs ─────────────────────────────────────────────────────

const CUES: Record<string, CueSpec> = {
  // WAKE — ascending two-note "ding" (E5 → A5). Reads as "ready for
  // input". User-validated v0.0.9 pick.
  wake: {
    tones: [
      { start: 0.00, dur: 0.10, freq: 659, peak: 0.40 }, // E5
      { start: 0.10, dur: 0.16, freq: 880, peak: 0.45 }, // A5
    ],
    total: 0.30,
  },

  // THINKING — quiet single 660 Hz "soft" tone. Fires when HA finishes
  // STT and starts intent processing. Tells the user "I heard you,
  // working on it now". Subtle so it doesn't compete with the TTS
  // reply that may follow within a second or two.
  thinking: {
    tones: [{ start: 0, dur: 0.18, freq: 660, peak: 0.35 }],
    total: 0.22,
  },

  // DONE — "bloop" downward pitch glide 880 → 440 Hz over 160 ms.
  // Reads as "session over, going back to idle". User-validated
  // v0.0.9 pick.
  done: {
    tones: [{ start: 0, dur: 0.16, freq: 880, freqEnd: 440, peak: 0.45 }],
    total: 0.22,
  },
};

// ── HTMLAudio cache ────────────────────────────────────────────────

const audioCache = new Map<string, HTMLAudioElement>();

/** Last-known user-overridden volume, 0..1. Applied at playback time. */
let cueVolume = 1.0;

/** Set the global multiplier applied to every cue. Clamped 0..1. */
export function setCueVolume(v: number): void {
  if (!Number.isFinite(v)) return;
  cueVolume = Math.max(0, Math.min(1, v));
  for (const a of audioCache.values()) a.volume = cueVolume;
}

function getAudio(id: string): HTMLAudioElement | null {
  const cached = audioCache.get(id);
  if (cached) return cached;
  const spec = CUES[id];
  if (!spec) return null;
  const wav = renderCueToWav(spec);
  const url = wavToDataUrl(wav);
  const a = new Audio(url);
  a.preload = 'auto';
  a.volume = cueVolume;
  audioCache.set(id, a);
  return a;
}

// ── Gesture priming ────────────────────────────────────────────────
//
// Most browsers require a real user gesture before any media element
// can play. On a kiosk that auto-starts the runner before the user
// has tapped anything, the very first cue gets dropped silently. We
// install a one-shot capture-phase listener on the document for the
// most common gesture events; on the first one we trigger every
// cached audio element's `play()` (muted, then pause) inside the
// gesture to whitelist them for the rest of the session.

let primed = false;
let primingInstalled = false;

function installGesturePriming(): void {
  if (primingInstalled || typeof document === 'undefined') return;
  primingInstalled = true;
  const events = ['pointerdown', 'touchstart', 'keydown', 'mousedown'] as const;
  const handler = (): void => {
    if (primed) return;
    primed = true;
    for (const id of Object.keys(CUES)) getAudio(id);
    for (const a of audioCache.values()) {
      try {
        a.currentTime = 0;
        a.muted = true;
        const p = a.play();
        if (p) {
          p.then(() => {
            a.pause();
            a.currentTime = 0;
            a.muted = false;
          }).catch(() => {
            a.muted = false;
          });
        }
      } catch {
        a.muted = false;
      }
    }
    for (const ev of events) document.removeEventListener(ev, handler, true);
  };
  for (const ev of events) document.addEventListener(ev, handler, true);
}

/** Public hook: install priming once the card is connected to DOM. */
export function installAudioPriming(): void {
  installGesturePriming();
}

// ── Playback ───────────────────────────────────────────────────────

async function playCueId(id: string): Promise<void> {
  installGesturePriming();
  const audio = getAudio(id);
  if (!audio) return;
  try {
    audio.currentTime = 0;
    audio.volume = cueVolume;
    const playPromise = audio.play();
    if (!playPromise) return;
    await playPromise;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        audio.removeEventListener('ended', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`uww-assist-card: HTMLAudio cue '${id}' rejected, trying WebAudio`, err);
    try {
      await playCueWebAudio(CUES[id]!);
    } catch (err2) {
      // eslint-disable-next-line no-console
      console.warn(`uww-assist-card: WebAudio fallback for '${id}' also failed`, err2);
    }
  }
}

/** Wake-detection cue. Plays the "ding" unless `name === 'none'`. */
export function playWakeSound(name: WakeSoundName): Promise<void> {
  if (silenced(name)) return Promise.resolve();
  return playCueId('wake');
}

/**
 * Thinking cue. Fires the moment HA finishes STT and starts intent
 * processing — tells the user "I heard you, working on it now".
 * Plays the quiet single 660 Hz "soft" tone.
 */
export function playThinkingCue(name: WakeSoundName): Promise<void> {
  if (silenced(name)) return Promise.resolve();
  return playCueId('thinking');
}

/** Done cue. Turn ended with no follow-up — "bloop" downward glide. */
export function playDoneCue(name: WakeSoundName): Promise<void> {
  if (silenced(name)) return Promise.resolve();
  return playCueId('done');
}

// ── WebAudio fallback ──────────────────────────────────────────────

let fallbackCtx: AudioContext | null = null;

function getFallbackCtx(): AudioContext | null {
  if (fallbackCtx) return fallbackCtx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor: typeof AudioContext | undefined = (window as any).AudioContext ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    fallbackCtx = new Ctor();
    return fallbackCtx;
  } catch {
    return null;
  }
}

async function playCueWebAudio(spec: CueSpec): Promise<void> {
  const c = getFallbackCtx();
  if (!c) throw new Error('no AudioContext');
  if (c.state === 'suspended') {
    // Properly await — fire-and-forget `void resume()` was the
    // original bug in this module: oscillators scheduled against a
    // never-running timeline got silently dropped on backgrounded
    // kiosks.
    await c.resume();
  }
  const t0 = c.currentTime + 0.005;
  for (const tone of spec.tones) {
    const osc = c.createOscillator();
    osc.type = 'sine';
    const start = t0 + tone.start;
    const end = start + tone.dur;
    const peak = tone.peak * cueVolume;
    osc.frequency.setValueAtTime(tone.freq, start);
    if (tone.freqEnd !== undefined) {
      osc.frequency.linearRampToValueAtTime(tone.freqEnd, end);
    }
    const gain = c.createGain();
    const att = Math.min(ATTACK, tone.dur * 0.3);
    const rel = Math.min(RELEASE, tone.dur * 0.5);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + att);
    gain.gain.setValueAtTime(Math.max(peak, 0.0002), end - rel);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
  await new Promise((r) => setTimeout(r, spec.total * 1000 + 30));
}

// ── WAV rendering ──────────────────────────────────────────────────

/**
 * Render the cue spec to a mono 16-bit PCM WAV at {@link SAMPLE_RATE}.
 *
 * Each tone uses a long cosine attack/decay envelope so the cue has
 * no audible click at start or end. Tones with {@link ToneSpec.freqEnd}
 * use a running-phase accumulator (rather than `sin(2πft)`) so the
 * frequency can sweep without phase discontinuities.
 */
function renderCueToWav(spec: CueSpec): ArrayBuffer {
  const samples = Math.floor(spec.total * SAMPLE_RATE) + 256;
  const pcm = new Float32Array(samples);

  for (const tone of spec.tones) {
    const startSample = Math.floor(tone.start * SAMPLE_RATE);
    const durSamples = Math.floor(tone.dur * SAMPLE_RATE);
    const attSamples = Math.min(
      Math.floor(ATTACK * SAMPLE_RATE),
      Math.floor(durSamples * 0.3),
    );
    const relSamples = Math.min(
      Math.floor(RELEASE * SAMPLE_RATE),
      Math.floor(durSamples * 0.5),
    );

    // Phase accumulator so glissando tones don't pop on frequency change.
    let phase = 0;
    const f0 = tone.freq;
    const f1 = tone.freqEnd ?? tone.freq;

    for (let i = 0; i < durSamples; i++) {
      const idx = startSample + i;
      if (idx >= pcm.length) break;

      // Cosine attack / release envelope.
      let env = 1;
      if (i < attSamples) {
        env = 0.5 - 0.5 * Math.cos((Math.PI * i) / attSamples);
      } else if (i > durSamples - relSamples) {
        const k = (durSamples - i) / relSamples;
        env = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, k));
      }

      const t = durSamples > 1 ? i / (durSamples - 1) : 0;
      const f = f0 + (f1 - f0) * t;
      phase += (2 * Math.PI * f) / SAMPLE_RATE;

      pcm[idx] += Math.sin(phase) * tone.peak * env;
    }
  }

  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]!) > 0.95) pcm[i] = Math.tanh(pcm[i]!);
  }

  return floatPcmToWav(pcm, SAMPLE_RATE);
}

function floatPcmToWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  let off = 0;
  const writeStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i));
  };
  writeStr('RIFF');
  dv.setUint32(off, 36 + dataSize, true); off += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  dv.setUint32(off, 16, true); off += 4;       // chunk size
  dv.setUint16(off, 1, true); off += 2;        // PCM
  dv.setUint16(off, 1, true); off += 2;        // mono
  dv.setUint32(off, sampleRate, true); off += 4;
  dv.setUint32(off, sampleRate * 2, true); off += 4;
  dv.setUint16(off, 2, true); off += 2;        // block align
  dv.setUint16(off, 16, true); off += 2;       // bits per sample
  writeStr('data');
  dv.setUint32(off, dataSize, true); off += 4;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]!));
    dv.setInt16(off, v * 0x7fff, true);
    off += 2;
  }
  return buf;
}

function wavToDataUrl(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let bin = '';
  // Chunked base64 to avoid stack-overflow with String.fromCharCode(...big).
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      u8.subarray(i, i + CHUNK) as any,
    );
  }
  return 'data:audio/wav;base64,' + btoa(bin);
}
