import { UWW, fetchManifest, validateManifest, type WakeWordManifest } from 'uww.js';

import { ManualWakeWordPipeline, type AudioMode } from './manual-pipeline.js';
import { loadManifestAndModel, loadModel } from './model-cache.js';
import type { HassLite, UwwAssistCardConfig } from './types.js';

export type { AudioMode } from './manual-pipeline.js';
export type WakeWordEvent = 'wake' | 'statuschange' | 'error';

export interface WakeWordRunnerEvents {
  wake: { probability: number; timestamp: number };
  statuschange: { status: 'idle' | 'loading' | 'listening' | 'error' };
  error: { error: Error };
}

interface ResolvedWakeWord {
  /** Raw model bytes / URL — uww.js's `wakeWordModel` shape. */
  modelData: ArrayBuffer | string;
  /** Parsed manifest, if the source was a manifest URL. */
  manifest?: WakeWordManifest;
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_SLIDING_WINDOW = 5;
const DEFAULT_REFRACTORY_MS = 2000;

/**
 * Wraps either {@link UWW} (preferred) or our own
 * {@link ManualWakeWordPipeline} (Safari/iOS fallback) so callers see
 * a single API regardless of which audio path is in use.
 *
 * On every `start()` we first try UWW with its built-in 16 kHz
 * `getUserMedia` request. If the resulting `AudioContext` actually
 * runs at 16 kHz, we keep it. If the browser silently chose a
 * different rate (Safari/iOS), we tear UWW down and start the manual
 * pipeline instead — which captures at the browser's native rate and
 * downsamples in an AudioWorklet before feeding the wake-word model.
 *
 * The `strict_sample_rate` config option survives as a kill-switch:
 * if explicitly set to `true`, we never auto-fall-back and instead
 * surface the original "sample-rate mismatch" error (useful for
 * debugging or when the user wants to know).
 */
export class WakeWordRunner {
  private uww: UWW | null = null;
  private manual: ManualWakeWordPipeline | null = null;
  private resolved: ResolvedWakeWord | null = null;
  private listeners = new Map<WakeWordEvent, Set<(detail: unknown) => void>>();

  constructor(
    private readonly config: UwwAssistCardConfig,
    private readonly hass: HassLite | undefined,
  ) {}

  public get wakeWordName(): string | null {
    return (
      this.uww?.wakeWordName ?? this.resolved?.manifest?.wake_word ?? null
    );
  }

  public get status(): 'idle' | 'loading' | 'listening' | 'error' {
    return this.uww?.status ?? (this.manual ? 'listening' : 'idle');
  }

  public on<E extends WakeWordEvent>(
    event: E,
    fn: (detail: WakeWordRunnerEvents[E]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = fn as (detail: unknown) => void;
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }

  /** Load the model (if needed) and start listening. */
  public async start(): Promise<void> {
    if (this.manual) {
      // Already on the fallback path — just (re)start.
      await this.manual.start();
      return;
    }

    // Native runner needs to own the mic stream so it can redirect
    // frames to the pipeline after wake. UWW owns its own internal
    // mic, so for native mode we must skip UWW entirely and go
    // straight to the manual pipeline.
    if (this.config.runner === 'native') {
      if (!this.resolved) this.resolved = await this.resolveWakeWord();
      await this.startManual();
      return;
    }

    if (!this.uww) {
      // First start of the session: resolve source once (caches the
      // bytes/manifest for any subsequent fallback to manual).
      if (!this.resolved) this.resolved = await this.resolveWakeWord();
      this.uww = await this.buildUww();
      this.attach(this.uww);
    }
    await this.uww.start();

    const actual = this.uww.getDebug().sampleRate ?? null;
    if (actual !== null && actual !== 16000) {
      if (this.config.strict_sample_rate === true) {
        const err = new Error(
          `uww-assist-card: AudioContext sample rate is ${actual} Hz, ` +
            'but the wake-word model was trained at 16000 Hz. ' +
            'Set `strict_sample_rate: false` (default) to enable in-browser resampling.',
        );
        this.emit('error', { error: err });
        throw err;
      }
      // eslint-disable-next-line no-console
      console.info(
        `uww-assist-card: browser provided ${actual} Hz audio; ` +
          'switching to in-process resampling to feed the 16 kHz wake-word model.',
      );
      await this.switchToManual();
    }
  }

  /**
   * Route post-wake audio frames. Only meaningful when the manual
   * pipeline is in use (native runner or Safari/iOS fallback). On
   * UWW (dialog mode at 16 kHz native) this is a no-op — UWW owns
   * the mic and we don't see frames.
   */
  public setAudioMode(mode: AudioMode): void {
    this.manual?.setMode(mode);
  }

  /** Set the sink for `pipeline`-mode frames. */
  public setFrameSink(sink: ((frame: Float32Array) => void) | null): void {
    this.manual?.setFrameSink(sink);
  }

  /** True when audio mode switching is available (i.e., manual path active). */
  public get supportsFrameRouting(): boolean {
    return this.manual !== null;
  }

  /** Stop listening. Releases the {@link MediaStream}; model stays loaded. */
  public async stop(): Promise<void> {
    if (this.manual) {
      await this.manual.stop();
      return;
    }
    if (!this.uww) return;
    await this.uww.stop();
  }

  public pause(): Promise<void> {
    return this.stop();
  }

  public resume(): Promise<void> {
    return this.start();
  }

  public async dispose(): Promise<void> {
    if (this.manual) {
      const m = this.manual;
      this.manual = null;
      await m.dispose();
    }
    if (this.uww) {
      const u = this.uww;
      this.uww = null;
      await u.dispose();
    }
    this.resolved = null;
  }

  // ── internals ───────────────────────────────────────────────────────

  private async switchToManual(): Promise<void> {
    if (!this.uww || !this.resolved) return;
    // Tear down the UWW that's running at the wrong rate.
    const u = this.uww;
    this.uww = null;
    try {
      await u.dispose();
    } catch {
      /* ignore */
    }
    await this.startManual();
  }

  private async startManual(): Promise<void> {
    if (!this.resolved) return;
    const modelData = this.resolved.modelData;
    const manifest = this.resolved.manifest;

    const threshold =
      this.config.threshold ??
      manifest?.micro.probability_cutoff ??
      DEFAULT_THRESHOLD;
    const slidingWindowSize =
      this.config.sliding_window_size ??
      manifest?.micro.sliding_window_size ??
      DEFAULT_SLIDING_WINDOW;
    const refractoryMs =
      this.config.refractory_ms ?? DEFAULT_REFRACTORY_MS;

    this.manual = new ManualWakeWordPipeline({
      wakeWordModel: modelData,
      wasmPath: this.wasmPath(),
      threshold,
      slidingWindowSize,
      refractoryMs,
      onWake: (detail) => this.emit('wake', detail),
      onError: (detail) => this.emit('error', detail),
    });
    await this.manual.start();
    this.emit('statuschange', { status: 'listening' });
  }

  private async buildUww(): Promise<UWW> {
    const resolved = this.resolved!;
    const wakeWord = resolved.manifest
      ? { manifest: resolved.manifest, modelData: resolved.modelData }
      : { wakeWordModel: resolved.modelData };
    const opts: ConstructorParameters<typeof UWW>[0] = { wakeWord };
    if (this.config.threshold !== undefined) {
      opts.threshold = this.config.threshold;
    }
    if (this.config.sliding_window_size !== undefined) {
      opts.slidingWindowSize = this.config.sliding_window_size;
    }
    if (this.config.refractory_ms !== undefined) {
      opts.refractoryMs = this.config.refractory_ms;
    }
    opts.wasmPath = this.wasmPath();
    return new UWW(opts);
  }

  private wasmPath(): string {
    return this.config.wasm_path
      ? this.resolveUrl(this.config.wasm_path)
      : new URL('./wasm/', import.meta.url).toString();
  }

  private attach(uww: UWW): void {
    uww.addEventListener('wake', (e) => {
      this.emit('wake', (e as CustomEvent).detail);
    });
    uww.addEventListener('statuschange', (e) => {
      this.emit('statuschange', (e as CustomEvent).detail);
    });
    uww.addEventListener('error', (e) => {
      this.emit('error', (e as CustomEvent).detail);
    });
  }

  /**
   * Resolve the configured `wake_word_url` to raw bytes + optional
   * manifest. Goes through {@link model-cache} so the model is served
   * from the browser's Cache Storage on subsequent loads.
   *
   * Used by both the UWW build path and (cached on the runner) the
   * manual-pipeline fallback so we don't re-fetch.
   */
  private async resolveWakeWord(): Promise<ResolvedWakeWord> {
    const url = this.config.wake_word_url;
    if (typeof url !== 'string' || !url) {
      throw new Error('uww-assist-card: wake_word_url is required');
    }
    const resolved = this.resolveUrl(url);
    const isModel = /\.tflite($|\?)/i.test(resolved);

    if (isModel) {
      try {
        const { modelData, fromCache } = await loadModel(resolved);
        // eslint-disable-next-line no-console
        console.debug(
          `uww-assist-card: model ${fromCache ? 'hit cache' : 'fetched fresh'} (${resolved})`,
        );
        return { modelData };
      } catch (err) {
        // Cache-layer failure — let uww.js do its own fetch via URL.
        // eslint-disable-next-line no-console
        console.warn(
          'uww-assist-card: cached model load failed; UWW will refetch',
          err,
        );
        return { modelData: resolved };
      }
    }

    try {
      const { manifest, modelData, fromCache } =
        await loadManifestAndModel(resolved);
      // eslint-disable-next-line no-console
      console.debug(
        `uww-assist-card: model ${fromCache ? 'hit cache' : 'fetched fresh'} (${resolved})`,
      );
      return { modelData, manifest };
    } catch (err) {
      // Cache miss / parse error — fall back to uww.js's manifest fetch.
      // eslint-disable-next-line no-console
      console.warn(
        'uww-assist-card: cached manifest load failed; refetching uncached',
        err,
      );
      try {
        const fresh = await fetchManifest(resolved);
        // Last-ditch: we still need raw bytes for a potential manual
        // fallback. Fetch the model bytes ourselves so a switchToManual
        // doesn't blow up later.
        const modelRes = await fetch(fresh.modelUrl);
        if (!modelRes.ok) throw new Error(`HTTP ${modelRes.status}`);
        return {
          modelData: await modelRes.arrayBuffer(),
          manifest: validateManifest(fresh.manifest),
        };
      } catch {
        return { modelData: resolved };
      }
    }
  }

  /**
   * Resolve URLs the way HA's frontend does:
   * - Absolute URLs (http/https) → returned as-is.
   * - Origin-relative (`/local/...`) → prepended with `hass.hassUrl()`
   *   so the card works when HA is reverse-proxied at a sub-path.
   * - Anything else → treated as relative to the dashboard origin.
   */
  private resolveUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/') && this.hass?.hassUrl) {
      try {
        return this.hass.hassUrl(url);
      } catch {
        // hassUrl can throw on unconfigured instances — fall through.
      }
    }
    return new URL(url, window.location.href).toString();
  }

  private emit<E extends WakeWordEvent>(
    event: E,
    detail: WakeWordRunnerEvents[E],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(detail);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('uww-assist-card: wake-word listener threw', err);
      }
    }
  }
}
