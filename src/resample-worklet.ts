/**
 * AudioWorklet processor source for {@link ResamplingAudioCapture}.
 *
 * Captures mic audio at the AudioContext's native rate (typically
 * 44.1 / 48 kHz on browsers that ignore the 16 kHz `sampleRate`
 * hint — notably Safari/iOS) and outputs fixed-size Float32 frames
 * at exactly 16 kHz.
 *
 * Linear interpolation downsampling — perfectly adequate for
 * wake-word detection (no audible artifacts in the speech band, and
 * the audio frontend's mel filterbank smooths everything else out).
 * A poly-phase filter would be marginally cleaner but is not worth
 * the extra code.
 *
 * Processor options:
 *   - frameSize:   samples per emitted frame at 16 kHz
 *   - targetRate:  destination rate (16000)
 */
export const RESAMPLE_WORKLET_SOURCE = `
class ResampleProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.frameSize = opts.frameSize || 160;
    this.targetRate = opts.targetRate || 16000;
    this.sourceRate = sampleRate;
    this.step = this.sourceRate / this.targetRate;
    this.readPos = 0;
    this.tail = new Float32Array(0);
    this.out = new Float32Array(this.frameSize);
    this.outIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    if (ch.length === 0) return true;

    // Concat the carry-over tail with the new chunk so the read
    // position spans across worklet quanta seamlessly.
    let buf;
    if (this.tail.length) {
      buf = new Float32Array(this.tail.length + ch.length);
      buf.set(this.tail, 0);
      buf.set(ch, this.tail.length);
    } else {
      buf = ch;
    }

    // Linear-interpolate at fractional source positions until the
    // read cursor exceeds buf.length - 1.
    let pos = this.readPos;
    while (pos < buf.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const sample = buf[i] * (1 - frac) + buf[i + 1] * frac;
      this.out[this.outIdx++] = sample;
      if (this.outIdx >= this.frameSize) {
        this.port.postMessage(this.out);
        this.out = new Float32Array(this.frameSize);
        this.outIdx = 0;
      }
      pos += this.step;
    }

    // Preserve the unread tail (the last sample at index floor(pos)
    // and onwards, including the fractional remainder) for next call.
    const consumed = Math.floor(pos);
    this.tail = buf.slice(consumed);
    this.readPos = pos - consumed;
    return true;
  }
}

registerProcessor('uww-resample', ResampleProcessor);
`;
