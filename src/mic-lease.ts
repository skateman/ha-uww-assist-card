/**
 * Cross-tab/card mic lease.
 *
 * Only one card instance, across all open dashboard tabs, holds the mic
 * lease at a time. Holders heartbeat every {@link HEARTBEAT_MS}; if no
 * heartbeat arrives for {@link STEAL_AFTER_MS}, any other waiter may
 * claim the lease.
 *
 * The protocol runs over a {@link BroadcastChannel} so it works across
 * same-origin tabs without any server-side coordination.
 *
 * Messages on the channel:
 *
 * - `claim`      — sent when an idle instance wants the lease.
 * - `heartbeat`  — sent every HEARTBEAT_MS by the current holder.
 * - `release`    — sent when the holder cleanly gives up the lease.
 */

const CHANNEL = 'uww-assist-card-mic-lease';
const HEARTBEAT_MS = 2000;
const STEAL_AFTER_MS = 5000;

type MsgType = 'claim' | 'heartbeat' | 'release';

interface LeaseMessage {
  type: MsgType;
  /** Random per-instance token of the sender. */
  token: string;
  /** Wall-clock ms at sender. */
  at: number;
}

export type LeaseEvent = 'acquired' | 'lost';

export class MicLeaseManager {
  private readonly token = crypto.randomUUID();
  private channel: BroadcastChannel | null = null;
  private listeners = new Map<LeaseEvent, Set<() => void>>();

  private wantsLease = false;
  private hasLease = false;

  private lastForeignHeartbeatAt = 0;
  private foreignToken: string | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stealTimer: ReturnType<typeof setInterval> | null = null;

  public get held(): boolean {
    return this.hasLease;
  }

  /** Express interest in the lease. Acquires immediately if it's free. */
  public request(): void {
    if (this.wantsLease) return;
    this.wantsLease = true;
    this.ensureChannel();
    this.send('claim');
    // Race: if nobody answers with a heartbeat within STEAL_AFTER_MS,
    // we claim the lease ourselves.
    this.scheduleSteal();
  }

  /** Cleanly release the lease (or cancel an outstanding request). */
  public release(): void {
    this.wantsLease = false;
    if (this.hasLease) {
      this.hasLease = false;
      this.send('release');
      this.stopHeartbeat();
      this.emit('lost');
    }
    this.clearStealTimer();
  }

  public on(event: LeaseEvent, fn: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  public destroy(): void {
    this.release();
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }

  // ── internals ───────────────────────────────────────────────────────

  private ensureChannel(): void {
    if (this.channel) return;
    if (typeof BroadcastChannel === 'undefined') {
      // No cross-tab coordination available — degrade to "always lease".
      this.acquire();
      return;
    }
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.addEventListener('message', this.onMessage);
  }

  private readonly onMessage = (ev: MessageEvent<LeaseMessage>): void => {
    const msg = ev.data;
    if (!msg || msg.token === this.token) return;

    if (msg.type === 'heartbeat' || msg.type === 'claim') {
      this.lastForeignHeartbeatAt = Date.now();
      this.foreignToken = msg.token;

      if (msg.type === 'claim' && this.hasLease) {
        // Defend our lease by replying with a heartbeat right away so
        // the other tab knows we're alive.
        this.send('heartbeat');
      }
    } else if (msg.type === 'release') {
      if (this.foreignToken === msg.token) {
        this.foreignToken = null;
        this.lastForeignHeartbeatAt = 0;
      }
      if (this.wantsLease && !this.hasLease) {
        this.acquire();
      }
    }
  };

  private scheduleSteal(): void {
    this.clearStealTimer();
    this.stealTimer = setInterval(() => {
      if (!this.wantsLease || this.hasLease) {
        this.clearStealTimer();
        return;
      }
      const stale =
        this.lastForeignHeartbeatAt === 0 ||
        Date.now() - this.lastForeignHeartbeatAt > STEAL_AFTER_MS;
      if (stale) {
        this.acquire();
      }
    }, 1000);
  }

  private clearStealTimer(): void {
    if (this.stealTimer) {
      clearInterval(this.stealTimer);
      this.stealTimer = null;
    }
  }

  private acquire(): void {
    this.hasLease = true;
    this.clearStealTimer();
    this.send('heartbeat');
    this.heartbeatTimer = setInterval(() => {
      if (this.hasLease) this.send('heartbeat');
    }, HEARTBEAT_MS);
    this.emit('acquired');
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(type: MsgType): void {
    if (!this.channel) return;
    const msg: LeaseMessage = { type, token: this.token, at: Date.now() };
    try {
      this.channel.postMessage(msg);
    } catch {
      // Channel may have been closed under us; ignore.
    }
  }

  private emit(event: LeaseEvent): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('uww-assist-card: lease listener threw', err);
      }
    }
  }
}
