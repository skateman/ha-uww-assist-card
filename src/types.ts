export interface UwwAssistCardConfig {
  type: string;
  /**
   * Wake-word source URL. `.tflite` → treated as a raw model;
   * anything else (typically `.json`) → microWakeWord manifest.
   * Auto-detected by extension.
   */
  wake_word_url: string;
  pipeline_id?: 'preferred' | 'last_used' | string;
  threshold?: number;
  sliding_window_size?: number;
  refractory_ms?: number;
  auto_start?: boolean;
  auto_close?: boolean;
  /** @deprecated use `display: 'invisible'` to fully hide. */
  show_status?: boolean;
  /**
   * Visual presentation.
   *   `full`      – default; title + status pill + buttons + counter
   *   `compact`   – single row: just the status pill
   *   `invisible` – render nothing (height 0); still arms + listens
   */
  display?: 'full' | 'compact' | 'invisible';
  strict_sample_rate?: boolean;
  companion_app?: 'dialog' | 'native';
  wasm_path?: string;
  /** Audible cue on wake. Defaults to 'chime'. */
  wake_sound?: 'chime' | 'beep' | 'none';
  /** Lovelace card name override. */
  name?: string;
}

export type CardStatus =
  | 'idle'
  | 'loading'
  | 'listening'
  | 'wake'
  | 'busy'
  | 'error';

/**
 * Subset of the AssistPipeline shape used by the visual editor's
 * pipeline dropdown.
 */
export interface AssistPipelineRef {
  id: string;
  name: string;
  [key: string]: unknown;
}

// Minimal subset of the HA frontend `hass` object we touch. We avoid
// pulling in `home-assistant-js-websocket` types just for this.
export interface HassLite {
  hassUrl?: (path?: string) => string;
  states?: Record<string, unknown>;
  auth?: {
    external?: {
      config: { hasAssist?: boolean };
      fireMessage: (msg: unknown) => void;
    };
  };
  connection?: {
    subscribeMessage: <T = unknown>(
      callback: (event: T) => void,
      subscribeMessage: { type: string; [k: string]: unknown },
      options?: { resubscribe?: boolean },
    ) => Promise<() => void>;
    sendMessagePromise?: <T = unknown>(msg: {
      type: string;
      [k: string]: unknown;
    }) => Promise<T>;
    socket?: WebSocket;
  };
  callWS?: <T = unknown>(msg: {
    type: string;
    [k: string]: unknown;
  }) => Promise<T>;
}
