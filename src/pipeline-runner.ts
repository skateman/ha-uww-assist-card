import { TtsPlayer } from './tts-player.js';
import type { HassLite } from './types.js';

const SAFETY_NET_MS = 60_000;

/** Pipeline lifecycle stages we surface to the caller. */
export type PipelineStage =
  | 'starting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'done'
  | 'error';

export interface PipelineRunnerOptions {
  hass: HassLite | undefined;
  /**
   * Pipeline id. `'preferred'` / `'last_used'` cause the param to be
   * omitted (HA backend then picks the preferred pipeline).
   * A real id is passed through unchanged.
   */
  pipelineId?: 'preferred' | 'last_used' | string;
  /** Stage transitions for the caller's UI. */
  onStage: (stage: PipelineStage) => void;
  /** Called once when the run (including any continue-conversation chain) ends. */
  onDone: (reason: 'normal' | 'cancel' | 'error' | 'safety' | 'lease-lost') => void;
  /** Called when the runner needs to control mic routing (mute during TTS, etc.). */
  setAudioMode: (mode: 'pipeline' | 'muted') => void;
}

interface PipelineEvent {
  type: string;
  data?: {
    runner_data?: { stt_binary_handler_id?: number };
    stt_output?: { text?: string };
    intent_output?: {
      continue_conversation?: boolean;
      conversation_id?: string;
    };
    tts_output?: { url?: string };
    code?: string;
    message?: string;
  };
}

/**
 * Drives HA's `assist_pipeline/run` WebSocket flow without going
 * through `ha-voice-command-dialog`.
 *
 * Sequence per turn:
 *   1. Subscribe to `assist_pipeline/run` (start_stage stt, end_stage tts).
 *   2. Wait for `run-start` → harvest `runner_data.stt_binary_handler_id`.
 *   3. Stream PCM as binary WS frames (`[handlerId, …int16-LE bytes]`).
 *   4. On `stt-vad-end` stop sending audio (HA server has its own VAD).
 *   5. On `tts-end` start playback, **mute** the mic so TTS doesn't
 *      leak back into the next STT.
 *   6. On `run-end` with `continue_conversation`, wait for TTS playback
 *      to finish, then start a fresh run with the stored
 *      `conversation_id`. Otherwise emit `done`.
 *
 * The class is single-turn-chain — call `cancel()` to abort, then
 * construct a new one for the next wake.
 */
export class PipelineRunner {
  private readonly opts: PipelineRunnerOptions;
  private readonly tts = new TtsPlayer();

  private unsubscribe: (() => void) | null = null;
  private handlerId: number | null = null;
  /** Buffered Int16 frames waiting for the handler id. */
  private pendingFrames: Int16Array[] = [];
  /** While true, incoming frames are forwarded to the WS socket. */
  private streaming = false;
  /** Set true when STT is done; further audio is ignored. */
  private sttClosed = false;
  /** Conversation id sticking across continue-conversation chains. */
  private conversationId: string | undefined;
  /** Latest TTS playback promise (resolved when audio.ended fires). */
  private ttsDone: Promise<void> = Promise.resolve();
  /** Whether the current run wants a follow-up turn. */
  private continueConversation = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private done = false;

  constructor(opts: PipelineRunnerOptions) {
    this.opts = opts;
  }

  /** Start the first run of the chain. */
  async start(): Promise<void> {
    this.opts.onStage('starting');
    this.armSafetyTimer();
    try {
      await this.startRun(undefined);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('uww-assist-card: pipeline run failed to start', err);
      this.finish('error');
    }
  }

  /**
   * Feed a Float32 frame (already at 16 kHz) into the runner. The
   * caller (wake-word audio router) must keep calling this for every
   * frame while the runner is active. The runner internally decides
   * whether to forward, buffer, or drop.
   */
  feedFrame(frame: Float32Array): void {
    if (this.done || this.sttClosed) return;
    const pcm = floatTo16BitPCM(frame);
    if (this.handlerId == null || !this.streaming) {
      // Buffer until the handler id arrives so we don't drop the
      // beginning of the user's utterance. Cap to ~3 s (300 frames of
      // 10 ms each) so a stuck pipeline can't grow this unbounded.
      if (this.pendingFrames.length < 300) {
        this.pendingFrames.push(pcm);
      }
      return;
    }
    this.sendFrame(pcm);
  }

  /** Cancel the run. Idempotent. */
  cancel(reason: 'cancel' | 'lease-lost' = 'cancel'): void {
    if (this.done) return;
    // eslint-disable-next-line no-console
    console.debug(`uww-assist-card: pipeline runner cancelled (${reason})`);
    this.finish(reason);
  }

  // ── private ───────────────────────────────────────────────────────

  private async startRun(conversationId: string | undefined): Promise<void> {
    const conn = this.opts.hass?.connection;
    if (!conn?.subscribeMessage || !conn.socket) {
      throw new Error('hass.connection unavailable');
    }
    this.handlerId = null;
    this.sttClosed = false;
    this.streaming = false;
    this.continueConversation = false;
    this.opts.setAudioMode('pipeline');

    const msg: Record<string, unknown> = {
      type: 'assist_pipeline/run',
      start_stage: 'stt',
      end_stage: 'tts',
      input: { sample_rate: 16000 },
    };
    if (this.opts.pipelineId && this.opts.pipelineId !== 'preferred' &&
        this.opts.pipelineId !== 'last_used') {
      msg.pipeline = this.opts.pipelineId;
    }
    if (conversationId) {
      msg.conversation_id = conversationId;
    }

    this.unsubscribe = await conn.subscribeMessage(
      (event: unknown) => this.handleEvent(event as PipelineEvent),
      msg as { type: string; [k: string]: unknown },
    );
  }

  private handleEvent(ev: PipelineEvent): void {
    if (this.done) return;
    // eslint-disable-next-line no-console
    console.debug(`uww-assist-card: native pipeline event: ${ev.type}`);
    switch (ev.type) {
      case 'run-start': {
        const id = ev.data?.runner_data?.stt_binary_handler_id;
        if (typeof id === 'number') {
          this.handlerId = id;
          // Don't flush yet — mirror ha-assist-chat and wait for
          // `stt-start` so the backend is actually consuming audio.
        }
        break;
      }
      case 'stt-start':
        this.streaming = true;
        this.flushPending();
        this.opts.onStage('listening');
        break;
      case 'stt-vad-end':
      case 'stt-end':
        // HA has captured enough; stop streaming further audio so
        // we don't keep the upstream open and so the server can move
        // on to intent processing.
        this.closeStt();
        this.opts.onStage('thinking');
        break;
      case 'intent-end': {
        const out = ev.data?.intent_output;
        this.continueConversation = out?.continue_conversation === true;
        if (out?.conversation_id) this.conversationId = out.conversation_id;
        break;
      }
      case 'tts-start':
        this.opts.onStage('speaking');
        // Mute the mic so the TTS we're about to play doesn't get
        // recorded by the next STT (we have no AEC in the worklet).
        this.opts.setAudioMode('muted');
        break;
      case 'tts-end': {
        const url = ev.data?.tts_output?.url;
        if (url) {
          this.ttsDone = this.tts.play(url, this.opts.hass);
        }
        break;
      }
      case 'error': {
        const code = ev.data?.code ?? '';
        // Non-fatal pipeline endings: HA emits an `error` event for
        // things like "no speech detected" mid-turn. These should end
        // this turn but not be treated as failures by the caller —
        // otherwise routine empty wakes brick the card.
        const NON_FATAL = new Set([
          'stt-no-text-recognized',
          'stt-stream-failed',
          'intent-failed',
          'tts-failed',
        ]);
        // eslint-disable-next-line no-console
        console.warn(
          `uww-assist-card: pipeline error: ${code} ${ev.data?.message ?? ''}`,
        );
        // Continue-conversation is now invalid; force a normal end.
        this.continueConversation = false;
        this.finish(NON_FATAL.has(code) ? 'normal' : 'error');
        break;
      }
      case 'run-end':
        void this.onRunEnd();
        break;
      default:
        break;
    }
  }

  private async onRunEnd(): Promise<void> {
    // Tear down this subscription either way.
    this.cleanupSubscription();
    // Always wait for any TTS to finish before continuing or finishing.
    try {
      await this.ttsDone;
    } catch {
      /* ignore */
    }
    this.ttsDone = Promise.resolve();
    if (this.done) return;
    if (this.continueConversation) {
      // Re-open mic and start a fresh run keyed to the same convo.
      try {
        await this.startRun(this.conversationId);
        this.opts.onStage('starting');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('uww-assist-card: continue-conversation start failed', err);
        this.finish('error');
      }
    } else {
      this.finish('normal');
    }
  }

  private flushPending(): void {
    if (this.handlerId == null) return;
    for (const frame of this.pendingFrames) {
      this.sendFrame(frame);
    }
    this.pendingFrames = [];
  }

  private sendFrame(pcm: Int16Array): void {
    const socket = this.opts.hass?.connection?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Layout: [handlerId byte, …raw int16 little-endian bytes]
    const payload = new Uint8Array(1 + pcm.byteLength);
    payload[0] = this.handlerId!;
    payload.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
    try {
      socket.send(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('uww-assist-card: socket.send failed', err);
    }
  }

  /** Signal end-of-stream to HA (single-byte frame with just the handler). */
  private closeStt(): void {
    if (this.sttClosed) return;
    this.sttClosed = true;
    this.streaming = false;
    const socket = this.opts.hass?.connection?.socket;
    if (socket?.readyState === WebSocket.OPEN && this.handlerId != null) {
      try {
        socket.send(new Uint8Array([this.handlerId]));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('uww-assist-card: EOF send failed', err);
      }
    }
  }

  private cleanupSubscription(): void {
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('uww-assist-card: unsubscribe threw', err);
      }
      this.unsubscribe = null;
    }
    this.handlerId = null;
    this.streaming = false;
    this.pendingFrames = [];
  }

  private armSafetyTimer(): void {
    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn('uww-assist-card: pipeline runner safety timer fired');
      this.finish('safety');
    }, SAFETY_NET_MS);
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private finish(reason: 'normal' | 'cancel' | 'error' | 'safety' | 'lease-lost'): void {
    if (this.done) return;
    this.done = true;
    this.clearSafetyTimer();
    this.closeStt();
    this.cleanupSubscription();
    this.tts.stop();
    this.opts.setAudioMode('muted');
    this.opts.onStage(reason === 'error' ? 'error' : 'done');
    try {
      this.opts.onDone(reason);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('uww-assist-card: onDone threw', err);
    }
  }
}

/** Float32 [-1, 1] → Int16 little-endian (host order — we send raw bytes). */
function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
