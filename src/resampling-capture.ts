import { RESAMPLE_WORKLET_SOURCE } from './resample-worklet.js';

export interface ResamplingCaptureOptions {
  /** Target sample rate; always 16000 for microWakeWord. */
  targetSampleRate: number;
  /** Samples per emitted frame at the target rate. */
  frameSize: number;
  /** Called with each {@link frameSize}-sample Float32 frame. */
  onFrame: (frame: Float32Array) => void;
}

/**
 * Microphone capture that downsamples to a target rate on browsers
 * which ignore `getUserMedia({ audio: { sampleRate } })` (notably
 * Safari/iOS). Uses an AudioWorklet running linear-interpolation
 * downsampling; output is fixed-size Float32 frames pushed via
 * `onFrame`.
 *
 * Cleanly stops via {@link stop}, which closes the AudioContext and
 * releases the mic track.
 */
export class ResamplingAudioCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly opts: ResamplingCaptureOptions) {}

  get actualSampleRate(): number | null {
    return this.opts.targetSampleRate;
  }

  get sourceSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  async start(): Promise<void> {
    if (this.context) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'uww-assist-card: getUserMedia is not available in this context',
      );
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Don't even request 16 kHz — let the browser pick its native
        // rate; the worklet handles the conversion. Same anti-DSP
        // flags uww.js's own capture uses.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });

    // Same here — no sampleRate option. Use whatever the browser
    // gives us.
    this.context = new AudioContext();

    const blob = new Blob([RESAMPLE_WORKLET_SOURCE], {
      type: 'application/javascript',
    });
    const url = URL.createObjectURL(blob);
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.node = new AudioWorkletNode(this.context, 'uww-resample', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: {
        frameSize: this.opts.frameSize,
        targetRate: this.opts.targetSampleRate,
      },
    });
    this.node.port.onmessage = (ev) => {
      this.opts.onFrame(ev.data as Float32Array);
    };

    this.source = this.context.createMediaStreamSource(this.stream);
    this.source.connect(this.node);

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  async stop(): Promise<void> {
    try {
      this.node?.port.close();
    } catch {
      /* ignore */
    }
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.context && this.context.state !== 'closed') {
      await this.context.close();
    }
    this.context = null;
    this.stream = null;
    this.node = null;
    this.source = null;
  }
}
