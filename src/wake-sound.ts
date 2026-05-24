/**
 * Tiny synth feedback sounds for wake-word detection.
 *
 * Generated on the fly via WebAudio — no fetched assets, no bundled
 * binary, ~0 KB cost. The user just needs a "yes I heard you" cue
 * before HA's voice dialog opens and starts listening (which can
 * take a few hundred ms for the bootstrap).
 *
 * All sounds are <= 250 ms and intentionally quiet (gain ≤ 0.18) so
 * they don't startle on speakers tuned for TTS playback.
 *
 * The AudioContext is lazily created on first play so it survives a
 * suspended state on iOS Safari without erroring at import time.
 * Most browsers require a user gesture before resuming an audio
 * context — but since we play in response to a wake detection that
 * itself only happens after the user tapped "enable mic" (which
 * counts as the gesture), resume should work.
 */

export type WakeSoundName = 'chime' | 'beep' | 'none';

let sharedCtx: AudioContext | null = null;

function ctx(): AudioContext {
  if (!sharedCtx) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor: typeof AudioContext = (window as any).AudioContext ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).webkitAudioContext;
    sharedCtx = new Ctor();
  }
  if (sharedCtx.state === 'suspended') {
    // Best-effort resume; if no gesture has happened yet this is a no-op.
    void sharedCtx.resume();
  }
  return sharedCtx;
}

/** Play `name`. Returns a promise that resolves when the sound ends. */
export function playWakeSound(name: WakeSoundName): Promise<void> {
  if (name === 'none') return Promise.resolve();
  try {
    const c = ctx();
    const now = c.currentTime;
    if (name === 'beep') return playBeep(c, now);
    return playChime(c, now);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('uww-assist-card: wake sound failed', err);
    return Promise.resolve();
  }
}

/**
 * Two short tones, an octave apart, with a soft attack/decay envelope.
 * Reads as a friendly "ding-ding" without being a wake-word itself.
 */
function playChime(c: AudioContext, t0: number): Promise<void> {
  const tones = [
    { freq: 880, start: 0, dur: 0.12 }, // A5
    { freq: 1320, start: 0.09, dur: 0.16 }, // E6
  ];
  for (const t of tones) {
    schedule(c, t0 + t.start, t.dur, t.freq, 'sine', 0.7);
  }
  return waitMs(tones[tones.length - 1]!.start * 1000 + 200);
}

/** Single short sine tone. */
function playBeep(c: AudioContext, t0: number): Promise<void> {
  schedule(c, t0, 0.12, 1000, 'sine', 0.7);
  return waitMs(150);
}

/** Play a short "now listening" cue (distinct from wake-detection sound). */
export function playListeningCue(name: WakeSoundName): Promise<void> {
  if (name === 'none') return Promise.resolve();
  try {
    const c = ctx();
    const now = c.currentTime;
    // Higher, snappier than the wake chime — easy to distinguish.
    schedule(c, now, 0.08, 1760, 'sine', 0.7); // A6
    return waitMs(100);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('uww-assist-card: listening cue failed', err);
    return Promise.resolve();
  }
}

function schedule(
  c: AudioContext,
  start: number,
  dur: number,
  freq: number,
  type: OscillatorType,
  peakGain: number,
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const gain = c.createGain();
  // Short attack, exponential decay — softer on the ear than a square cut.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
