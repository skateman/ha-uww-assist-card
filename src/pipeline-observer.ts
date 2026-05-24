import type { HassLite } from './types.js';

/**
 * Pipeline-run event shape used by HA's `assist_pipeline/run` subscription.
 *
 * NOTE: unlike a generic websocket subscription where the callback
 * receives `{ event: <payload> }`, `runAssistPipeline` (used by
 * `ha-assist-chat`) is wired so the callback gets the raw event
 * payload directly. So we read `.type` straight off the argument
 * passed to the subscribed callback — not via `.event.type`.
 */
interface PipelineEvent {
  type: string;
  data?: {
    intent_output?: {
      continue_conversation?: boolean;
      conversation_id?: string;
    };
  };
}

type SubscribeFn = (
  callback: (event: unknown) => void,
  msg: { type: string; [k: string]: unknown },
  options?: { resubscribe?: boolean },
) => Promise<() => void>;

interface PatchableConnection {
  subscribeMessage: SubscribeFn;
}

const PATCH_MARKER = Symbol.for('uww-assist-card.pipeline-observer.patch');

/**
 * Observes Assist pipeline events while a voice dialog is open.
 *
 * HA's `<ha-assist-chat>` runs the pipeline via the standard
 * `hass.connection.subscribeMessage({ type: 'assist_pipeline/run', … })`
 * websocket subscription. We don't want to start our own parallel
 * pipeline (that would cost a duplicate STT run on HA), so instead we
 * temporarily wrap the connection's `subscribeMessage` method.
 *
 * For the lifetime of the wrap, every callback registered for
 * `assist_pipeline/run` is intercepted: we sniff the events as they
 * flow through (and forward them unchanged to the original callback,
 * so chat behaviour is unaffected). When we see `run-end` with no
 * pending `continue_conversation`, we invoke {@link OnCloseRequested}
 * — the caller fires HA's `close-dialog` event to dismiss the dialog.
 *
 * The patch is strictly scoped to one dialog turn (install on open,
 * uninstall on dialog-closed). On uninstall, we restore the original
 * method only if no third party has wrapped on top of us — defensive
 * check via a Symbol-keyed marker.
 *
 * `continue_conversation` tracking is per-run: we reset on every
 * `run-start` so a previous turn's value can't leak into the next.
 */
export class PipelineObserver {
  private connection: PatchableConnection | null = null;
  private originalSubscribe: SubscribeFn | null = null;
  private installed = false;
  private continueConversation = false;
  private readonly onCloseRequested: () => void;

  constructor(onCloseRequested: () => void) {
    this.onCloseRequested = onCloseRequested;
  }

  public install(hass: HassLite | undefined): void {
    if (this.installed) return;
    const connection = hass?.connection as PatchableConnection | undefined;
    if (!connection) {
      // eslint-disable-next-line no-console
      console.warn(
        'uww-assist-card: pipeline observer not installed (no hass.connection)',
      );
      return;
    }

    this.connection = connection;
    this.continueConversation = false;
    this.originalSubscribe = connection.subscribeMessage.bind(connection);

    const wrapped: SubscribeFn = (callback, msg, options) => {
      // Only intercept pipeline runs; everything else passes through
      // unchanged via the bound original.
      if (msg?.type !== 'assist_pipeline/run') {
        return this.originalSubscribe!(callback, msg, options);
      }
      const interceptingCallback = (event: unknown) => {
        try {
          this.handleEvent(event as PipelineEvent);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('uww-assist-card: pipeline observer threw', err);
        }
        callback(event);
      };
      return this.originalSubscribe!(interceptingCallback, msg, options);
    };

    // Mark the wrapper so we can detect on uninstall whether something
    // else patched on top of us. If so, leave the chain alone rather
    // than blow away the other patch.
    (wrapped as unknown as { [PATCH_MARKER]: true })[PATCH_MARKER] = true;

    connection.subscribeMessage = wrapped;
    this.installed = true;
  }

  public uninstall(): void {
    if (!this.installed || !this.connection || !this.originalSubscribe) {
      this.installed = false;
      this.connection = null;
      this.originalSubscribe = null;
      return;
    }
    const current = this.connection.subscribeMessage as unknown as {
      [PATCH_MARKER]?: true;
    };
    if (current[PATCH_MARKER]) {
      // No third party patched over us — safe to restore.
      this.connection.subscribeMessage = this.originalSubscribe;
    } else {
      // Someone else wrapped on top. Leave the chain in place.
      // eslint-disable-next-line no-console
      console.warn(
        'uww-assist-card: pipeline observer left wrapper in place ' +
          '(third party wrapped over our patch)',
      );
    }
    this.installed = false;
    this.connection = null;
    this.originalSubscribe = null;
    this.continueConversation = false;
  }

  // ── event handling ──────────────────────────────────────────────────

  private handleEvent(ev: PipelineEvent): void {
    if (!ev || typeof ev.type !== 'string') return;
    // eslint-disable-next-line no-console
    console.debug(`uww-assist-card: pipeline event: ${ev.type}`);

    switch (ev.type) {
      case 'run-start':
        // New pipeline run — reset our per-turn flag so a previous
        // turn's value doesn't leak.
        this.continueConversation = false;
        break;
      case 'intent-end':
        this.continueConversation =
          ev.data?.intent_output?.continue_conversation === true;
        // eslint-disable-next-line no-console
        console.debug(
          `uww-assist-card: intent-end, continue_conversation=${this.continueConversation}`,
        );
        break;
      case 'error':
        // Pipeline error — close the dialog so the user doesn't have to.
        // (The runner won't be in a usable state to continue anyway.)
        this.requestClose('error');
        break;
      case 'run-end':
        if (!this.continueConversation) {
          this.requestClose('run-end without continue_conversation');
        }
        break;
      // Other events (stt-start, stt-vad-end, stt-end, intent-progress,
      // intent-start, tts-start, tts-end) are not our business — they
      // continue to flow through to ha-assist-chat untouched.
      default:
        break;
    }
  }

  private requestClose(reason: string): void {
    // eslint-disable-next-line no-console
    console.debug(`uww-assist-card: pipeline observer requesting close (${reason})`);
    try {
      this.onCloseRequested();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('uww-assist-card: onCloseRequested threw', err);
    }
  }
}