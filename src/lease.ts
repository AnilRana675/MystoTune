/**
 * M6.1 session lease (doc 7.11): at most one instance serves Telegram I/O per
 * lease slot, so a Render redeploy can never run two Telegram sessions with
 * the same AUTH_KEY.
 *
 * Contract: acquire with SET NX PX (lease:session:{slot} = instanceId), keep
 * alive with a compare-and-extend Lua script (Appendix A), self-fence when
 * renewals keep failing (~30 s of misses), release with compare-and-delete on
 * SIGTERM. Without Redis the caller falls back to M5 boot-retry behaviour.
 */

import { randomBytes } from "node:crypto";
import os from "node:os";

import type { RedisStore } from "./redis.js";

/** Appendix A, verbatim: RENEW = compare holder, then PEXPIRE ttl(ms). */
export const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0";
/** Appendix A, verbatim: RELEASE = compare holder, then DEL. */
export const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

export interface LeaseIntervals {
  ttlMs: number;
  renewMs: number;
  pollMs: number;
}

/** Render gives each deploy RENDER_INSTANCE_ID; plain hosts get a hostname +
 * random suffix so two instances on one machine never share an id. */
export function deriveInstanceId(env: NodeJS.ProcessEnv, hostnameFn: () => string = os.hostname): string {
  const renderId = env["RENDER_INSTANCE_ID"]?.trim();
  if (renderId) return renderId;
  return `${hostnameFn()}-${randomBytes(2).toString("hex")}`;
}

export interface SessionLeaseOptions {
  redis: RedisStore | null;
  lease: LeaseIntervals;
  instanceId: string;
  /** Lease key suffix (doc 7.11 lease:session:{slot}; slot 0 is the default). */
  slot?: number;
  /** Sustained renewal-failure budget before self-fencing (default 30 s). */
  fenceMs?: number;
  /** Self-fence callback: caller drops Telegram I/O and falls back to STANDBY. */
  onFenced?: () => void;
}

export class SessionLease {
  /** Redis key for this slot: `lease:session:{slot}`. */
  readonly key: string;

  private readonly redis: RedisStore | null;
  private readonly instanceId: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private readonly fenceMs: number;
  private readonly onFencedFn: () => void;

  private heldLocal = false;
  private fencedFlag = false;
  private misses = 0;
  private renewTimer: NodeJS.Timeout | null = null;

  constructor(opts: SessionLeaseOptions) {
    this.redis = opts.redis;
    this.instanceId = opts.instanceId;
    this.ttlMs = opts.lease.ttlMs;
    this.renewMs = opts.lease.renewMs;
    this.fenceMs = opts.fenceMs ?? 30_000;
    this.onFencedFn = opts.onFenced ?? (() => {});
    this.key = `lease:session:${opts.slot ?? 0}`;
  }

  get isHeld(): boolean {
    return this.heldLocal;
  }

  get isFenced(): boolean {
    return this.fencedFlag;
  }

  /**
   * Doc 7.11: STANDBY polls tryAcquire every pollMs — true the moment the slot
   * was acquired (or is already held by this instance). No Redis ⇒ never held.
   */
  async tryAcquire(): Promise<boolean> {
    if (this.fencedFlag) return false;
    if (this.heldLocal) return true;
    if (!this.redis) return false;
    const took = await this.redis.setIfAbsent(this.key, this.instanceId, this.ttlMs);
    if (took) {
      this.heldLocal = true;
      this.misses = 0;
      this.startRenewTimer();
    }
    return took;
  }

  /**
   * One renew beat (doc 7.11: every renewMs). A refresh success clears the
   * miss streak; failures (including transport errors, which return -1) count
   * toward the fence budget — sustained failure self-fences.
   */
  async renewBeat(): Promise<void> {
    if (this.fencedFlag || !this.heldLocal || !this.redis) return;
    const refreshed = (await this.redis.evalLua(RENEW_LUA, [this.key], [this.instanceId, String(this.ttlMs)])) === 1;
    if (refreshed) {
      this.misses = 0;
      return;
    }
    this.misses += 1;
    const allowed = this.fenceMs > 0 ? Math.max(1, Math.ceil(this.fenceMs / this.renewMs)) : 1;
    if (this.misses >= allowed) {
      this.fencedFlag = true;
      this.heldLocal = false;
      this.stopRenewTimer();
      this.onFencedFn(); // self-fence: caller stops Telegram I/O, drops STANDBY
    }
  }

  /**
   * SIGTERM path (doc 7.11): stop renewing and compare-and-delete our own
   * lease (Appendix A RELEASE). True only when this instance held the slot.
   */
  async release(): Promise<boolean> {
    this.stopRenewTimer();
    if (!this.heldLocal || !this.redis) {
      this.heldLocal = false;
      return false;
    }
    this.heldLocal = false;
    return (await this.redis.evalLua(RELEASE_LUA, [this.key], [this.instanceId])) === 1;
  }

  private startRenewTimer(): void {
    if (this.renewTimer) return;
    const t = setInterval(() => void this.renewBeat(), this.renewMs);
    t.unref();
    this.renewTimer = t;
  }

  private stopRenewTimer(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }
}
