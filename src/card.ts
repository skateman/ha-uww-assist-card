import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import { AssistDialogBridge } from './dialog-bridge.js';
import { friendlyError } from './errors.js';
import { MicLeaseManager } from './mic-lease.js';
import type { CardStatus, HassLite, UwwAssistCardConfig } from './types.js';
import { WakeWordRunner } from './wake-word.js';
import { playWakeSound, type WakeSoundName } from './wake-sound.js';

declare const __HA_UWW_VERSION__: string;

declare global {
  interface Window {
    customCards?: Array<{
      type: string;
      name: string;
      description?: string;
      preview?: boolean;
      documentationURL?: string;
    }>;
  }
}

@customElement('uww-assist-card')
export class UwwAssistCard extends LitElement {
  @property({ attribute: false }) public hass?: HassLite;

  @state() private _config?: UwwAssistCardConfig;
  @state() private _status: CardStatus = 'idle';
  @state() private _wakeWordName: string | null = null;
  @state() private _leaseHeld = false;
  @state() private _wakeCount = 0;
  @state() private _lastWakeAt: number | null = null;
  @state() private _error: string | null = null;
  @state() private _errorHint: string | null = null;

  private _lease?: MicLeaseManager;
  private _runner?: WakeWordRunner;
  private _bridge?: AssistDialogBridge;
  private _runnerCleanups: Array<() => void> = [];
  private _wantsArm = false;
  /** Wall-clock ms; wake events with timestamp before this are dropped. */
  private _ignoreWakeUntil = 0;

  // ── Lovelace card API ───────────────────────────────────────────────

  public setConfig(config: UwwAssistCardConfig): void {
    if (!config) throw new Error('uww-assist-card: config is required');
    if (typeof config.wake_word_url !== 'string' || !config.wake_word_url.trim()) {
      throw new Error(
        'uww-assist-card: `wake_word_url` is required (a manifest .json or .tflite URL)',
      );
    }
    const wasConfigured = !!this._config;
    this._config = { ...config, wake_word_url: config.wake_word_url.trim() };

    if (wasConfigured) {
      void this._teardownRunner();
      this._wakeWordName = null;
      this._error = null;
      this._errorHint = null;
    }
  }

  public getCardSize(): number {
    // Even for invisible mode we return 1: HA's section grid may skip
    // mounting a card it sees as having no size, and we still need
    // the element in the DOM to run the wake-word loop + receive
    // hass updates.
    return 1;
  }

  public static getStubConfig(): Partial<UwwAssistCardConfig> {
    return {
      type: 'custom:uww-assist-card',
      wake_word_url:
        'https://cdn.jsdelivr.net/gh/esphome/micro-wake-word-models@main/models/v2/hey_jarvis.json',
      pipeline_id: 'preferred',
      auto_close: true,
    };
  }

  /**
   * Schema-based visual editor.
   *
   * Returning a `LovelaceConfigForm` makes HA render the form via its
   * built-in `hui-form-editor` (uses `ha-form` + the standard
   * selector library). Much simpler than registering a custom editor
   * element, and gets us native HA widgets (the `assist_pipeline`
   * selector knows how to list pipelines).
   *
   * NOTE: `wake_word.manifest_url` / `wake_word.model_url` live under
   * an object, which ha-form doesn't represent natively. We expose
   * two flat fields here (`wake_word_manifest_url`,
   * `wake_word_model_url`) and translate to/from the nested shape in
   * `setConfig`. The schema submits whatever was typed; we normalize.
   */
  public static getConfigForm() {
    const LABELS: Record<string, string> = {
      name: 'Card name',
      wake_word_url: 'Wake-word URL',
      pipeline_id: 'Assist pipeline',
      display: 'Display mode',
      auto_start: 'Auto-start on load',
      auto_close: 'Auto-close after turn',
      strict_sample_rate: 'Strict sample-rate check',
      wake_sound: 'Wake-detection sound',
      companion_app: 'HA Companion app behavior',
      threshold: 'Detection threshold (0–1)',
      sliding_window_size: 'Sliding window (frames)',
      refractory_ms: 'Refractory period (ms)',
      wasm_path: 'TFLite WASM path (advanced)',
    };
    const HELPERS: Record<string, string> = {
      wake_word_url:
        'JSON manifest (preferred) or raw .tflite URL. Auto-detected by extension.',
      display:
        'Full = title + status + buttons; Compact = single pill; Invisible = no UI (still listens).',
      auto_close:
        "Close HA's voice dialog when the AI's reply doesn't ask a follow-up.",
      strict_sample_rate:
        'Hard-fail instead of using in-browser resampling on browsers that ignore the requested 16 kHz rate (Safari/iOS).',
      wake_sound:
        'Short audible cue played on detection, before HA opens the voice dialog.',
      companion_app:
        'In the HA mobile app, hand off to the native Assist UI instead of opening the in-page dialog.',
      wasm_path:
        'Override the tfjs-tflite WASM directory. Defaults to the copy shipped with the card.',
    };

    const SCHEMA = [
      { name: 'name', selector: { text: {} } },
      { name: 'wake_word_url', selector: { text: {} } },
      { name: 'pipeline_id', selector: { assist_pipeline: {} } },
      {
        name: 'wake_sound',
        selector: {
          select: {
            mode: 'dropdown' as const,
            options: [
              { value: 'chime', label: 'Chime (default)' },
              { value: 'beep', label: 'Beep' },
              { value: 'none', label: 'None (silent)' },
            ],
          },
        },
      },
      {
        name: 'display',
        selector: {
          select: {
            mode: 'dropdown' as const,
            options: [
              { value: 'full', label: 'Full card (default)' },
              { value: 'compact', label: 'Compact (single pill)' },
              { value: 'invisible', label: 'Invisible (no UI)' },
            ],
          },
        },
      },
      {
        type: 'grid',
        name: '',
        schema: [
          { name: 'auto_start', selector: { boolean: {} } },
          { name: 'auto_close', selector: { boolean: {} } },
          { name: 'strict_sample_rate', selector: { boolean: {} } },
        ],
      },
      {
        type: 'expandable',
        name: 'detection_section',
        title: 'Detection tuning',
        flatten: true,
        schema: [
          {
            type: 'grid',
            name: '',
            schema: [
              {
                name: 'threshold',
                selector: {
                  number: {
                    min: 0,
                    max: 1,
                    step: 0.01,
                    mode: 'box' as const,
                  },
                },
              },
              {
                name: 'sliding_window_size',
                selector: {
                  number: { min: 1, step: 1, mode: 'box' as const },
                },
              },
              {
                name: 'refractory_ms',
                selector: {
                  number: { min: 0, step: 50, mode: 'box' as const },
                },
              },
            ],
          },
        ],
      },
      {
        type: 'expandable',
        name: 'advanced_section',
        title: 'Advanced',
        flatten: true,
        schema: [
          {
            name: 'companion_app',
            selector: {
              select: {
                mode: 'dropdown' as const,
                options: [
                  { value: 'dialog', label: 'Always open in-page dialog' },
                  {
                    value: 'native',
                    label: 'Use native Assist UI in mobile app',
                  },
                ],
              },
            },
          },
          { name: 'wasm_path', selector: { text: {} } },
        ],
      },
    ];

    return {
      schema: SCHEMA,
      computeLabel: (schema: { name: string }) =>
        LABELS[schema.name] ?? schema.name,
      computeHelper: (schema: { name: string }) =>
        HELPERS[schema.name] ?? '',
    };
  }

  // ── lifecycle ───────────────────────────────────────────────────────

  public override connectedCallback(): void {
    super.connectedCallback();
    this._ensureLease();
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._wantsArm = false;
    this._bridge?.destroy();
    this._bridge = undefined;
    void this._teardownRunner();
    this._lease?.destroy();
    this._lease = undefined;
    this._leaseHeld = false;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('_config')) {
      const mode = this._config?.display ??
        (this._config?.show_status === false ? 'invisible' : 'full');
      if (mode === 'invisible') {
        this.setAttribute('data-invisible', '');
      } else {
        this.removeAttribute('data-invisible');
      }
    }
  }

  protected override firstUpdated(_: PropertyValues): void {
    if (this._config?.auto_start) {
      void this._arm();
    }
  }

  // ── render ──────────────────────────────────────────────────────────

  protected override render() {
    if (!this._config) {
      return html`<ha-card><div class="pad">Configuring…</div></ha-card>`;
    }
    // Back-compat: `show_status: false` (legacy) maps to invisible mode.
    const mode = this._config.display ??
      (this._config.show_status === false ? 'invisible' : 'full');

    if (mode === 'invisible') {
      // Render an empty span so the host has a real (zero-size) child
      // in its shadow root. Some HA layout wrappers behave oddly if
      // shadowRoot is bare. Hide via CSS rather than `nothing` so
      // event dispatch + lifecycle is identical to other modes.
      return html`<span class="invisible-marker" hidden></span>`;
    }

    if (mode === 'compact') {
      const pillLabel =
        this._error ? 'error' :
        !this._wantsArm ? 'tap to enable' :
        this._status === 'listening' ? 'listening' :
        this._status === 'wake' ? 'wake' :
        this._status === 'busy' ? 'busy' :
        this._status === 'loading' ? 'loading' :
        this._status;
      const clickable = this._status === 'idle' || this._status === 'error' || !this._wantsArm;
      return html`
        <ha-card class="compact-card">
          <button
            class="compact-pill status-${this._status}"
            ?disabled=${!clickable && this._status !== 'listening' && this._status !== 'wake'}
            @click=${() =>
              clickable ? void this._arm() : void this._disarm()}
            title=${this._error
              ? this._error
              : this._wakeWordName
                ? `Wake word: "${this._wakeWordName}"`
                : 'uww Assist'}
          >
            ${pillLabel}
          </button>
        </ha-card>
      `;
    }

    // Full mode (default)
    const name = this._config.name ?? 'uww Assist';
    return html`
      <ha-card>
        <div class="pad">
          <div class="row">
            <span class="title">${name}</span>
            ${this._wakeWordName
              ? html`<span class="subtle">· "${this._wakeWordName}"</span>`
              : nothing}
          </div>
          <div class="row">
            <span class="pill status-${this._status}">${this._status}</span>
            ${this._leaseHeld
              ? html`<span class="pill lease">mic</span>`
              : this._wantsArm
                ? html`<span class="pill">waiting</span>`
                : nothing}
            ${this._wakeCount > 0
              ? html`<span class="subtle"
                  >wakes: ${this._wakeCount}${this._lastWakeAt
                    ? html` · ${this._fmtLast(this._lastWakeAt)}`
                    : nothing}</span
                >`
              : nothing}
          </div>
          ${this._renderArmButton()}
          ${this._error
            ? html`<div class="error">
                <strong>${this._error}</strong>
                ${this._errorHint
                  ? html`<div class="hint">${this._errorHint}</div>`
                  : nothing}
              </div>`
            : nothing}
          <div class="subtle ver">v${__HA_UWW_VERSION__}</div>
        </div>
      </ha-card>
    `;
  }

  private _renderArmButton() {
    if (
      this._status === 'idle' ||
      this._status === 'error' ||
      (!this._wantsArm && this._status !== 'loading')
    ) {
      return html`<button class="btn" @click=${() => void this._arm()}>
        ${this._error ? 'Retry' : 'Tap to enable mic'}
      </button>`;
    }
    return html`<button class="btn" @click=${() => void this._disarm()}>
      Stop
    </button>`;
  }

  // ── arm / disarm flow ───────────────────────────────────────────────

  private _ensureLease(): MicLeaseManager {
    if (this._lease) return this._lease;
    this._lease = new MicLeaseManager();
    this._lease.on('acquired', () => {
      this._leaseHeld = true;
      if (this._wantsArm) void this._startRunnerWithLease();
    });
    this._lease.on('lost', () => {
      this._leaseHeld = false;
      void this._teardownRunner({ keepWants: true });
    });
    return this._lease;
  }

  private async _arm(): Promise<void> {
    this._error = null;
    this._errorHint = null;
    this._wantsArm = true;
    const lease = this._ensureLease();
    lease.request();
    if (lease.held) {
      this._leaseHeld = true;
      await this._startRunnerWithLease();
    } else {
      // Waiting for an existing holder to release.
      this._status = 'loading';
    }
  }

  private async _disarm(): Promise<void> {
    this._wantsArm = false;
    await this._teardownRunner();
    this._lease?.release();
    this._leaseHeld = false;
    this._status = 'idle';
  }

  private async _startRunnerWithLease(): Promise<void> {
    if (!this._config || !this._wantsArm) return;
    if (this._runner) return; // already running
    this._status = 'loading';
    try {
      const runner = new WakeWordRunner(this._config, this.hass);
      this._runner = runner;

      this._runnerCleanups.push(
        runner.on('statuschange', ({ status }) => {
          if (status === 'listening') {
            // Stay in 'wake' state during the flash, then drop back to
            // 'listening' on its own timer.
            if (this._status !== 'wake') this._status = 'listening';
          } else if (status === 'loading') {
            this._status = 'loading';
          } else if (status === 'error') {
            this._status = 'error';
          }
        }),
        runner.on('wake', ({ probability, timestamp }) => {
          const now = Date.now();
          if (this._status !== 'listening' || now < this._ignoreWakeUntil) {
            // eslint-disable-next-line no-console
            console.debug(
              `uww-assist-card: stray wake ignored ` +
                `(status=${this._status}, ` +
                `cooldownRemaining=${Math.max(0, this._ignoreWakeUntil - now)}ms)`,
            );
            return;
          }
          this._wakeCount += 1;
          this._lastWakeAt = Date.now();
          // eslint-disable-next-line no-console
          console.log(
            'uww-assist-card: wake!',
            { probability, timestamp },
            this._wakeWordName,
          );
          void this._handleWake();
        }),
        runner.on('error', ({ error }) => {
          this._setError(error);
        }),
      );

      await runner.start();
      this._wakeWordName = runner.wakeWordName;
      this._status = 'listening';
    } catch (err) {
      this._setError(err);
      await this._teardownRunner({ keepWants: true });
    }
  }

  private _setError(err: unknown): void {
    const f = friendlyError(err);
    this._error = f.message;
    this._errorHint = f.hint ?? null;
    this._status = 'error';
    // eslint-disable-next-line no-console
    console.error('uww-assist-card:', err);
  }

  private async _handleWake(): Promise<void> {
    if (!this._config || !this._runner) return;
    if (this._bridge?.open) {
      // eslint-disable-next-line no-console
      console.debug('uww-assist-card: wake ignored (dialog already up)');
      return;
    }

    // Audible cue ASAP — bootstrap + show-dialog can take a few
    // hundred ms before the mic indicator appears in HA's dialog.
    // Fire-and-forget; we don't block the rest of the wake flow on it.
    const soundName = (this._config.wake_sound ?? 'chime') as WakeSoundName;
    void playWakeSound(soundName);

    // Flash status to 'wake' briefly so the UI shows something even
    // before the dialog has rendered.
    this._status = 'wake';
    // eslint-disable-next-line no-console
    console.debug('uww-assist-card: wake → pausing runner, opening dialog');

    // Release the mic before the dialog tries to acquire it.
    try {
      await this._runner.pause();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('uww-assist-card: runner pause failed', err);
    }
    this._status = 'busy';

    const bridge = (this._bridge ??= new AssistDialogBridge(this));
    void bridge.openDialog({
      hass: this.hass,
      pipelineId: this._config.pipeline_id,
      companionApp: this._config.companion_app ?? 'dialog',
      autoClose: this._config.auto_close !== false,
      onClose: () => {
        // eslint-disable-next-line no-console
        console.debug('uww-assist-card: bridge.onClose fired');
        void this._afterDialogClose();
      },
    });
  }

  private async _afterDialogClose(): Promise<void> {
    if (!this._wantsArm || !this._runner) {
      this._status = 'idle';
      return;
    }
    const BUSY_MS = 400;
    const BLACKOUT_MS = 2500;
    this._ignoreWakeUntil = Date.now() + BLACKOUT_MS;
    this._status = 'busy';
    await new Promise<void>((resolve) => setTimeout(resolve, BUSY_MS));
    if (!this._wantsArm || !this._runner) {
      this._status = 'idle';
      return;
    }
    this._status = 'loading';
    try {
      await this._runner.resume();
      this._ignoreWakeUntil = Math.max(
        this._ignoreWakeUntil,
        Date.now() + BLACKOUT_MS,
      );
      this._status = 'listening';
    } catch (err) {
      this._setError(err);
    }
  }

  private async _teardownRunner(opts?: {
    keepWants?: boolean;
  }): Promise<void> {
    for (const off of this._runnerCleanups) off();
    this._runnerCleanups = [];
    const runner = this._runner;
    this._runner = undefined;
    if (runner) {
      try {
        await runner.dispose();
      } catch {
        /* swallow */
      }
    }
    if (!opts?.keepWants) {
      this._wantsArm = false;
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private _fmtLast(t: number): string {
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    return `${mins}m ago`;
  }

  public static override styles = css`
    :host {
      display: block;
    }
    :host([data-invisible]) {
      display: contents;
    }
    .invisible-marker {
      display: none;
    }
    .pad {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .title {
      font-weight: 600;
    }
    .subtle {
      color: var(--secondary-text-color);
      font-size: 0.85em;
    }
    .ver {
      margin-top: 4px;
      font-size: 0.75em;
    }
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.78em;
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      text-transform: lowercase;
    }
    .pill.status-listening,
    .pill.lease {
      background: var(--success-color, #4caf50);
      color: white;
    }
    .pill.status-wake,
    .pill.status-busy {
      background: var(--warning-color, #ff9800);
      color: white;
    }
    .pill.status-error {
      background: var(--error-color, #f44336);
      color: white;
    }
    .pill.status-loading {
      background: var(--info-color, #2196f3);
      color: white;
    }
    /* Compact mode: card chrome is just an inline-sized pill */
    .compact-card {
      display: inline-block;
      background: transparent !important;
      box-shadow: none !important;
      border: none !important;
      width: auto;
    }
    .compact-pill {
      display: inline-block;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.95em;
      font: inherit;
      border: none;
      cursor: pointer;
      text-transform: lowercase;
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
    }
    .compact-pill:hover {
      filter: brightness(1.05);
    }
    .compact-pill:disabled {
      cursor: default;
    }
    .compact-pill.status-listening {
      background: var(--success-color, #4caf50);
      color: white;
    }
    .compact-pill.status-wake,
    .compact-pill.status-busy {
      background: var(--warning-color, #ff9800);
      color: white;
    }
    .compact-pill.status-error {
      background: var(--error-color, #f44336);
      color: white;
    }
    .compact-pill.status-loading {
      background: var(--info-color, #2196f3);
      color: white;
    }
    .btn {
      align-self: flex-start;
      padding: 8px 14px;
      border: none;
      border-radius: 8px;
      background: var(--primary-color);
      color: var(--text-primary-color, white);
      cursor: pointer;
      font: inherit;
    }
    .btn:hover {
      filter: brightness(1.05);
    }
    .error {
      color: var(--error-color, #f44336);
      font-size: 0.9em;
      white-space: pre-wrap;
    }
    .error .hint {
      color: var(--secondary-text-color);
      font-size: 0.88em;
      margin-top: 4px;
      white-space: normal;
    }
  `;
}

// Make the card discoverable in HA's card picker.
window.customCards = window.customCards ?? [];
if (!window.customCards.some((c) => c.type === 'uww-assist-card')) {
  window.customCards.push({
    type: 'uww-assist-card',
    name: 'uww Assist Card',
    description: 'In-browser microWakeWord detection that triggers HA Assist.',
    preview: false,
    documentationURL: 'https://github.com/skateman/ha-uww-assist-card',
  });
}
