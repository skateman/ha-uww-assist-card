import { PipelineObserver } from './pipeline-observer.js';
import type { HassLite } from './types.js';

const DIALOG_TAG = 'ha-voice-command-dialog';
const SAFETY_NET_MS = 60_000;

export type CompanionApp = 'dialog' | 'native';

export interface OpenOptions {
  hass: HassLite | undefined;
  pipelineId?: 'preferred' | 'last_used' | string;
  companionApp: CompanionApp;
  /** Enable PipelineObserver auto-close on non-continuing turns. */
  autoClose: boolean;
  /** Called when STT enters its listening phase (so the caller can play a cue). */
  onSttStart?: () => void;
  /** Called exactly once when the dialog is dismissed or the safety net fires. */
  onClose: () => void;
}

/**
 * Bridges a wake-word detection into HA's existing voice-command dialog.
 *
 * On {@link openDialog}, dispatches the standard `show-dialog` event
 * that HA's frontend listens for at the root, asking it to display
 * `ha-voice-command-dialog` with `start_listening: true`. HA's dialog
 * then runs the whole Assist pipeline (STT → intent → TTS) itself.
 *
 * We listen for the bubbling+composed `dialog-closed` event HA's
 * dialog fires on close, and signal the caller via
 * {@link OpenOptions.onClose} so it can re-arm the wake-word listener.
 *
 * ## Lazy-load bootstrap
 *
 * HA lazy-loads the dialog chunk the first time the user opens the
 * sidebar mic icon (or hits the `A` keyboard shortcut, etc). Until
 * that has happened in the current page load, the `ha-voice-command-
 * dialog` custom element isn't registered, and firing `show-dialog`
 * with a no-op `dialogImport` makes HA throw
 *   `Error: Unknown dialog type loaded`
 * *and* poisons its internal `LOADED` cache for the rest of the page
 * load.
 *
 * {@link bootstrap} works around this by triggering HA's *own* URL-
 * based opener (`?conversation=1`, which `hui-root` listens for), then
 * auto-closing the briefly-opened dialog as soon as the element is
 * defined. From then on the cache has a proper entry and our normal
 * `show-dialog` flow with `start_listening: true` works.
 */
export class AssistDialogBridge {
  private readonly host: HTMLElement;
  private isOpen = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private onCloseCb?: () => void;
  private observer: PipelineObserver | null = null;

  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  public get open(): boolean {
    return this.isOpen;
  }

  /**
   * One-time per page load: force HA to load the ha-voice-command-dialog
   * chunk via its URL-based opener, then close the dialog that
   * automatically pops up as a side effect.
   *
   * Safe to call repeatedly — first call does the work, the rest await
   * the cached promise.
   */
  public bootstrap(): Promise<void> {
    if (this.bootstrapped) return Promise.resolve();
    if (this.bootstrapPromise) return this.bootstrapPromise;
    if (customElements.get(DIALOG_TAG)) {
      this.bootstrapped = true;
      return Promise.resolve();
    }

    this.bootstrapPromise = (async () => {
      // Set ?conversation=1 and tell hui-root the location changed.
      // hui-root's _handleUrlChanged calls _showVoiceCommandDialog,
      // which calls showVoiceCommandDialog → which lazy-imports the
      // dialog chunk via HA's webpack-resolved path.
      const url = new URL(window.location.href);
      url.searchParams.set('conversation', '1');
      window.history.replaceState(window.history.state, '', url);
      window.dispatchEvent(new CustomEvent('location-changed'));

      // Wait for the element to be defined.
      await Promise.race([
        customElements.whenDefined(DIALOG_TAG),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('bootstrap timeout')), 10_000),
        ),
      ]);

      // Wait for the dialog to actually mount and finish opening before
      // we close it. HA's `showDialog` is async (it awaits
      // `_loadPipelines` first), so the element appears in the DOM
      // before `_dialogOpen` is set true. Closing too early lets the
      // pending state flip re-open the dialog, dialog-closed never
      // fires, and our subsequent `show-dialog` hits an already-open
      // dialog → no remount → no mic.
      const dialog = await this.waitForDialogOpen();
      if (!dialog) {
        // Couldn't find or open it; assume HA loaded the chunk anyway
        // and continue. Subsequent openDialog calls will likely work.
        this.bootstrapped = true;
        return;
      }

      // Programmatically close, then wait for the real `dialog-closed`
      // event before resolving. This guarantees that when we later
      // fire `show-dialog` with start_listening:true, HA re-renders
      // <ha-assist-chat> from scratch so its firstUpdated() actually
      // sees startListening=true and toggles the mic on.
      const closed = this.waitForDialogClosed();
      const closeFn = (dialog as unknown as { closeDialog?: () => void })
        .closeDialog;
      if (typeof closeFn === 'function') closeFn.call(dialog);
      await closed;

      this.bootstrapped = true;
    })().catch((err) => {
      // Reset so a later wake can retry. Re-throw so openDialog hits
      // its fallback path with a clear log.
      this.bootstrapPromise = null;
      throw err;
    });

    return this.bootstrapPromise;
  }

  /** Open the dialog (idempotent — returns false if already open). */
  public async openDialog(opts: OpenOptions): Promise<boolean> {
    if (this.isOpen) return false;
    this.isOpen = true;
    this.onCloseCb = opts.onClose;

    const pipelineId = opts.pipelineId ?? 'preferred';

    // Companion-app branch: hand off to the native Assist UI; no
    // in-page dialog → no `dialog-closed` event. Rely on the safety
    // timer to eventually resume.
    if (
      opts.companionApp === 'native' &&
      opts.hass?.auth?.external?.config.hasAssist
    ) {
      try {
        opts.hass.auth.external.fireMessage({
          type: 'assist/show',
          payload: { pipeline_id: pipelineId, start_listening: true },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('uww-assist-card: native assist hand-off failed', err);
        this.close();
        return false;
      }
      this.armSafetyTimer();
      return true;
    }

    // Ensure HA has loaded the dialog chunk before we fire show-dialog
    // — otherwise HA throws "Unknown dialog type loaded" and poisons
    // its cache for the rest of the page.
    try {
      await this.bootstrap();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        'uww-assist-card: dialog bootstrap failed; falling back to ' +
          'HA\'s own opener (start_listening will be false; click the ' +
          'mic in the dialog manually).',
        err,
      );
      this.openViaUrlOnly();
      window.addEventListener('dialog-closed', this.onDialogClosed, true);
      this.armSafetyTimer();
      return true;
    }

    // In-page dialog: fire HA's `show-dialog` event.
    // `bubbles + composed` so it crosses shadow-DOM boundaries and
    // reaches the <home-assistant> root that handles it.
    //
    // `addHistory: false` keeps HA out of the browser history. We
    // don't want the dialog to be re-openable by clicking Back, and
    // more importantly avoids HA calling history.back() on close —
    // which fires popstate, which can chain into other state
    // handlers and unexpectedly re-trigger the dialog.
    this.host.dispatchEvent(
      new CustomEvent('show-dialog', {
        detail: {
          dialogTag: DIALOG_TAG,
          // Element is already registered after bootstrap; HA reuses
          // its LOADED cache entry and won't call this.
          dialogImport: () => Promise.resolve(),
          dialogParams: {
            pipeline_id: pipelineId,
            start_listening: true,
          },
          addHistory: false,
        },
        bubbles: true,
        composed: true,
      }),
    );

    window.addEventListener('dialog-closed', this.onDialogClosed, true);

    // Install pipeline observer (if requested) so we can auto-close
    // the dialog when the AI's response doesn't ask for a follow-up.
    if (opts.autoClose) {
      this.observer = new PipelineObserver(
        () => this.requestDialogClose(),
        opts.onSttStart,
      );
      this.observer.install(opts.hass);
    }

    this.armSafetyTimer();
    return true;
  }

  public destroy(): void {
    if (this.isOpen) this.close();
  }

  // ── internals ───────────────────────────────────────────────────────

  private readonly onDialogClosed = (ev: Event): void => {
    const detail = (ev as CustomEvent).detail;
    if (!detail || detail.dialog !== DIALOG_TAG) return;
    // eslint-disable-next-line no-console
    console.debug('uww-assist-card: dialog-closed received');
    this.close();
  };

  private armSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(
        'uww-assist-card: safety timer fired — dialog never reported close',
      );
      this.close();
    }, SAFETY_NET_MS);
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    window.removeEventListener('dialog-closed', this.onDialogClosed, true);
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.observer) {
      this.observer.uninstall();
      this.observer = null;
    }
    const cb = this.onCloseCb;
    this.onCloseCb = undefined;
    if (cb) {
      try {
        cb();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('uww-assist-card: onClose callback threw', err);
      }
    }
  }

  /**
   * Ask HA's dialog to close itself (in response to the pipeline
   * observer detecting a turn with no `continue_conversation`).
   *
   * IMPORTANT: HA's pipeline `run-end` event fires when the TTS *URL*
   * is ready, **not** when the user has finished hearing the TTS audio
   * play out. `<ha-assist-chat>` then creates an `<audio>` element with
   * the URL and starts playback asynchronously. If we fire `close-dialog`
   * immediately on run-end, we yank the dialog before the user hears
   * the answer. So we first wait for the chat's `_audio` element to
   * finish playback (or hit a safety timeout).
   *
   * Fires HA's `close-dialog` event on the host; HA's dialog manager
   * listens for this and translates into the dialog's `closeDialog()`
   * method. The dialog's normal close path then fires `dialog-closed`
   * which our own listener catches → {@link close} → onClose callback.
   *
   * Falls back to calling the dialog's `closeDialog()` directly if the
   * event-driven path doesn't work for some reason.
   */
  private async requestDialogClose(): Promise<void> {
    if (!this.isOpen) return;

    // Wait for TTS playback to actually finish before closing.
    await this.waitForTtsPlaybackEnd();
    if (!this.isOpen) return;

    this.host.dispatchEvent(
      new CustomEvent('close-dialog', {
        bubbles: true,
        composed: true,
      }),
    );
    // Belt + braces: if close-dialog didn't take effect within 500 ms
    // (e.g. because HA's dialog manager doesn't handle it for this tag),
    // call the dialog's own close method directly.
    setTimeout(() => {
      if (!this.isOpen) return;
      const dialog = this.findDialog();
      const closeFn = (dialog as unknown as { closeDialog?: () => void })
        ?.closeDialog;
      if (typeof closeFn === 'function') closeFn.call(dialog);
    }, 500);
  }

  /**
   * Wait for `<ha-assist-chat>`'s TTS `<audio>` element to finish
   * playback. Resolves immediately if no audio is playing, or on the
   * `ended` / `pause` / `error` event of the current audio element.
   *
   * Has a hard cap so a stuck audio (e.g. a broken TTS URL) can't keep
   * the dialog open forever.
   */
  private waitForTtsPlaybackEnd(maxMs = 30_000): Promise<void> {
    const audio = this.findChatAudio();
    if (!audio) return Promise.resolve();
    // Already finished (or never started).
    if (audio.ended || audio.paused) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        audio.removeEventListener('ended', finish);
        audio.removeEventListener('pause', finish);
        audio.removeEventListener('error', finish);
        clearTimeout(timer);
        resolve();
      };
      audio.addEventListener('ended', finish);
      audio.addEventListener('pause', finish);
      audio.addEventListener('error', finish);
      const timer = setTimeout(finish, maxMs);
    });
  }

  /**
   * Reach into `<ha-assist-chat>` and grab its private `_audio` field.
   * Yes, this is a private LitElement state — confined to this one
   * narrow case where we need to coordinate dialog dismissal with the
   * audio playback the chat owns. If HA renames or removes it the
   * worst case is we close on `run-end` like before, which is what we
   * had before this method.
   */
  private findChatAudio(): HTMLAudioElement | null {
    const dialog = this.findDialog();
    if (!dialog) return null;
    const chat = dialog.shadowRoot?.querySelector('ha-assist-chat');
    if (!chat) return null;
    const audio = (chat as unknown as { _audio?: HTMLAudioElement })._audio;
    return audio instanceof HTMLAudioElement ? audio : null;
  }

  /**
   * Find HA's voice-command dialog AND wait for it to finish its async
   * `showDialog(params)` (which awaits `_loadPipelines` before setting
   * `_dialogOpen=true`). Returns null on timeout.
   *
   * We poll until the dialog's private `_dialogOpen` flag is true. It's
   * a private LitElement state, but it's the most reliable signal that
   * HA's showDialog promise has actually settled — and using it is
   * confined to bootstrap, not steady-state operation.
   */
  private async waitForDialogOpen(timeoutMs = 5000): Promise<HTMLElement | null> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const el = this.findDialog();
      if (el) {
        const state = el as unknown as { _dialogOpen?: boolean };
        if (state._dialogOpen) return el;
      }
      if (performance.now() > deadline) return null;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  }

  /** Resolve when HA fires `dialog-closed` for our dialog tag. */
  private waitForDialogClosed(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
      const onClosed = (ev: Event): void => {
        const detail = (ev as CustomEvent).detail;
        if (!detail || detail.dialog !== DIALOG_TAG) return;
        window.removeEventListener('dialog-closed', onClosed, true);
        clearTimeout(t);
        resolve();
      };
      window.addEventListener('dialog-closed', onClosed, true);
      const t = setTimeout(() => {
        window.removeEventListener('dialog-closed', onClosed, true);
        resolve(); // best-effort — don't stall the bootstrap forever
      }, timeoutMs);
    });
  }

  private findDialog(): HTMLElement | null {
    // The dialog is mounted into <home-assistant>'s shadow root.
    const root = document.querySelector('home-assistant');
    const shadow = (root as Element | null)?.shadowRoot ?? null;
    return (
      (shadow?.querySelector(DIALOG_TAG) as HTMLElement | null) ?? null
    );
  }

  /**
   * Last-resort fallback: just trigger HA's URL opener. The dialog
   * shows with `start_listening: false`, so the user has to click the
   * mic inside the dialog. Better than no dialog at all.
   */
  private openViaUrlOnly(): void {
    const url = new URL(window.location.href);
    url.searchParams.set('conversation', '1');
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new CustomEvent('location-changed'));
  }
}

