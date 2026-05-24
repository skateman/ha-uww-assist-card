import { Detector, InferencePipeline } from 'uww.js';

import { ResamplingAudioCapture } from './resampling-capture.js';

export interface ManualPipelineOptions {
  /** Raw model bytes (or URL) — same shape uww.js accepts. */
  wakeWordModel: string | ArrayBuffer;
  /** TFLite WASM directory. */
  wasmPath: string;
  threshold: number;
  slidingWindowSize: number;
  refractoryMs: number;
  onWake: (detail: { probability: number; timestamp: number }) => void;
  onError: (detail: { error: Error }) => void;
}

/**
 * Self-contained wake-word loop using uww.js's exposed building
 * blocks (InferencePipeline + Detector) plus our own resampling
 * audio capture.
 *
 * Used as a fallback to UWW when the browser's AudioContext refuses
 * to operate at 16 kHz (notably Safari/iOS) — we run the mic at the
 * native rate and downsample in an AudioWorklet, instead of feeding
 * mis-aligned audio to the model.
 *
 * Behaviour mirrors UWW's `wake` / `error` events; `wakeWordName` is
 * not available here (callers carry that themselves from the
 * manifest if they need it).
 */
export class ManualWakeWordPipeline {
  private readonly pipeline = new InferencePipeline();
  private detector: Detector | null = null;
  private capture: ResamplingAudioCapture | null = null;
  private frameSize = 0;
  private processingFrame = false;
  private running = false;

  constructor(private readonly opts: ManualPipelineOptions) {}

  async start(): Promise<void> {
    if (this.running) return;
    if (this.frameSize === 0) {
      const info = await this.pipeline.load({
        wakeWordModel: this.opts.wakeWordModel,
        wasmPath: this.opts.wasmPath,
        sampleRate: 16000,
      });
      this.frameSize = info.frameSize;
      this.detector = new Detector({
        threshold: this.opts.threshold,
        windowSize: this.opts.slidingWindowSize,
        refractoryMs: this.opts.refractoryMs,
      });
    }
    this.capture = new ResamplingAudioCapture({
      targetSampleRate: 16000,
      frameSize: this.frameSize,
      onFrame: (frame) => this.handleFrame(frame),
    });
    try {
      await this.capture.start();
      this.running = true;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.capture) {
      const c = this.capture;
      this.capture = null;
      await c.stop();
    }
    this.detector?.reset();
    this.pipeline.resetState();
    this.running = false;
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.pipeline.dispose();
    this.detector = null;
    this.frameSize = 0;
  }

  private handleFrame(frame: Float32Array): void {
    if (!this.detector || this.processingFrame) return;
    this.processingFrame = true;
    try {
      const prob = this.pipeline.process(frame);
      const { fired, mean } = this.detector.push(prob);
      if (fired) {
        this.opts.onWake({
          probability: mean,
          timestamp: performance.now(),
        });
      }
    } catch (err) {
      this.fail(err);
    } finally {
      this.processingFrame = false;
    }
  }

  private fail(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.opts.onError({ error });
  }
}
