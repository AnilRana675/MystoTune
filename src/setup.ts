/**
 * M6.2 (doc 7.5-7.9, §8, §9): the guided setup website.
 *
 * One self-contained HTML page at /{secret}/setup exchanges a 144-bit boot
 * token (URL fragment `#t=` — browsers never send fragments, doc 7.5) for an
 * HttpOnly, SameSite=Strict cookie. Every /setup/api endpoint needs the
 * cookie plus a double-submit CSRF header (§8 CSRF row). 5 wrong tokens lock
 * the IP for 15 minutes; the global cap is 20 unlock attempts per hour.
 *
 * The Telegram login runs on a dedicated client with an empty StringSession
 * (floodSleepThreshold 0, connectionRetries 3): client.start()'s
 * phone/code/password callbacks are promises the matching HTTP endpoint
 * resolves (doc 7.6). A 5-minute idle timer discards the login state
 * entirely (§8 memory remnants). Errors map 1:1 to the 7.6 table.
 *
 * Finish (doc 7.9): verified config write, then a callback into main() that
 * swaps the runtime (fresh TelegramManager + indexer), moves SETUP → STANDBY
 * → ACTIVE and starts the indexer. Afterwards the site is closed — every
 * /setup/* route returns 404.
 *
 * All Telegram work goes through the `SetupLogin` seam so the flow is fully
 * testable with a mock Telegram (test plan §11).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config";
import type { ConfigStore, StoredConfigV1 } from "./configStore";
import type { RedisStore } from "./redis";

/* ------------------------------------------------------------------ errors */

/** Wizard error surfaced as `{ ok:false, code, message, next }` (doc 7.6). */
export class SetupError extends Error {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly next: string,
    readonly httpStatus = 400,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** Doc 7.6 table: thrown Telegram login error → wizard message + next step. */
export function mapLoginError(e: unknown): SetupError {
  const raw = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  const flood = /FLOOD_(?:WAIT|TEST_PHONE_WAIT|PREMIUM_WAIT)_(\d+)/.exec(raw);
  if (flood) {
    const secs = Number(flood[1] ?? 0);
    return new SetupError("flood_wait", `Telegram asks you to wait ${secs} s`, "Wait out the countdown, then retry", 429, secs);
  }
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/i.test(raw)) {
    return new SetupError("api_id_invalid", "The API ID and hash do not match", "Re-check at my.telegram.org");
  }
  if (/PHONE_NUMBER_INVALID|PHONE_BANNED/i.test(raw)) {
    return new SetupError("phone_number_invalid", "That phone number is not valid", "Use international format, for example +977…");
  }
  if (raw.includes("SESSION_PASSWORD_NEEDED")) {
    return new SetupError("password_needed", "Two-step verification is on", "Show the password field");
  }
  if (raw.includes("PASSWORD_HASH_INVALID")) {
    return new SetupError("password_invalid", "Wrong password", "Try again — no lockout on our side");
  }
  if (/PHONE_CODE_(INVALID|EXPIRED)|PHONE_CODE_EMPTY/i.test(raw)) {
    return new SetupError("phone_code_invalid", "The code is wrong or expired", "Request a new code");
  }
  return new SetupError("login_failed", (e instanceof Error ? e.message : "Login failed").slice(0, 200), "Check the steps, then retry");
}

/** Idle discard (doc 7.6): pending callbacks die, state resets. */
export const IDLE_ERROR = new SetupError(
  "login_idle",
  "The login timed out after 5 minutes",
  "Start again from the phone screen",
  408,
);

/* ------------------------------------------------------------ access guard */

/** Hash both sides for a constant-time compare (mirrors server.ts). */
function maskedEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

export type UnlockResult =
  | { ok: true; sid: string; csrf: string; maxAgeSec: number; secure: boolean }
  | { ok: false; code: "locked" | "rate_limited" | "invalid"; retryAfterSec: number; remaining?: number };

const UNLOCK_GLOBAL_PER_HOUR = 20;
const WRONG_TOKENS_LOCK = 5;
const LOCK_MS = 15 * 60_000;

/** Access guard (doc §8): token exchange, per-IP lock, global hourly cap. */
export class SetupAccess {
  /** 144-bit random token per boot, base64url (doc §8 brute-force row). */
  readonly token = randomBytes(18).toString("base64url");
  readonly cookieName = "setup";
  private readonly sessions = new Map<string, { csrf: string; until: number }>();
  private readonly failsByIp = new Map<string, { count: number; until: number }>();
  private readonly attempts: number[] = [];

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly secure = false,
  ) {}

  /** Constant-time check of the deploy-log token (session backup reveal). */
  tokenOk(candidate: unknown): boolean {
    return typeof candidate === "string" && maskedEqual(this.token, candidate);
  }

  /** Remaining per-IP lock in seconds (0 = not locked; tallies don't lock). */
  ipLockedSec(ip: string, now = Date.now()): number {
    const f = this.failsByIp.get(ip);
    if (!f || f.until <= now || f.count < WRONG_TOKENS_LOCK) return 0;
    return Math.ceil((f.until - now) / 1000);
  }

  attemptUnlock(ip: string, candidate: unknown, now = Date.now()): UnlockResult {
    this.prune(now);
    // Global cap counts EVERY unlock attempt, successful or not (§8).
    while (this.attempts.length > 0 && now - this.attempts[0]! > 3_600_000) this.attempts.shift();
    if (this.attempts.length >= UNLOCK_GLOBAL_PER_HOUR) {
      return { ok: false, code: "rate_limited", retryAfterSec: Math.max(1, Math.ceil((3_600_000 + this.attempts[0]! - now) / 1000)) };
    }
    this.attempts.push(now);

    const locked = this.ipLockedSec(ip, now);
    if (locked > 0 || (this.failsByIp.get(ip)?.count ?? 0) >= WRONG_TOKENS_LOCK) {
      return { ok: false, code: "locked", retryAfterSec: Math.max(locked, Math.ceil(LOCK_MS / 1000)) };
    }
    if (typeof candidate !== "string" || !maskedEqual(this.token, candidate)) {
      const f = this.failsByIp.get(ip) ?? { count: 0, until: now + 3_600_000 };
      f.count += 1;
      if (f.count < WRONG_TOKENS_LOCK) {
        // the strike tally survives prune() for an hour, then the 5th locks
        f.until = Math.max(f.until, now + 3_600_000);
        this.failsByIp.set(ip, f);
        return { ok: false, code: "invalid", retryAfterSec: 0, remaining: WRONG_TOKENS_LOCK - f.count };
      }
      f.until = now + LOCK_MS; // 15-min lock takes over from the tally window
      this.failsByIp.set(ip, f);
      return { ok: false, code: "locked", retryAfterSec: Math.ceil(LOCK_MS / 1000) };
    }
    // Success: mint the 30-minute session (HttpOnly id + double-submit CSRF).
    this.failsByIp.delete(ip);
    const sid = randomBytes(16).toString("hex");
    const csrf = randomBytes(18).toString("base64url");
    this.sessions.set(sid, { csrf, until: now + this.ttlMs });
    return { ok: true, sid, csrf, maxAgeSec: Math.floor(this.ttlMs / 1000), secure: this.secure };
  }

  /** Set-Cookie header line for a successful unlock (doc 7.5). */
  cookieHeader(ok: Extract<UnlockResult, { ok: true }>): string {
    const parts = [
      `${this.cookieName}=${ok.sid}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${ok.maxAgeSec}`,
    ];
    if (ok.secure) parts.push("Secure");
    return parts.join("; ");
  }

  /** Session id from the Cookie header, or undefined. */
  sidOf(req: { headers: { cookie?: string } }): string | undefined {
    for (const c of (req.headers.cookie ?? "").split(/;\s*/)) {
      const eq = c.indexOf("=");
      if (eq > 0 && c.slice(0, eq).trim() === this.cookieName) return c.slice(eq + 1).trim() || undefined;
    }
    return undefined;
  }

  /** Valid, unexpired cookie + matching `x-setup-csrf` double submit (§8). */
  authorized(req: { headers: { cookie?: string; "x-setup-csrf"?: string } }, now = Date.now()): boolean {
    const sid = this.sidOf(req);
    if (!sid) return false;
    const entry = this.sessions.get(sid);
    if (!entry) return false;
    if (entry.until <= now) {
      this.sessions.delete(sid);
      return false;
    }
    const header = req.headers["x-setup-csrf"] ?? "";
    return header.length > 0 && maskedEqual(entry.csrf, String(header));
  }

  /** Explicit session end (site close). */
  endSession(sid: string | undefined): void {
    if (sid) this.sessions.delete(sid);
  }

  private prune(now: number): void {
    for (const [sid, e] of this.sessions) if (e.until <= now) this.sessions.delete(sid);
    for (const [ip, f] of this.failsByIp) if (f.until <= now) this.failsByIp.delete(ip);
  }
}

/* --------------------------------------------------------------- login seam */

/** Doc 7.7 channel entry: -100… id + title. */
export interface SetupChannel {
  id: number;
  title: string;
}

/** client.start()-style callbacks: each is a promise an endpoint resolves. */
export interface LoginCallbacks {
  phone(): Promise<string>;
  code(): Promise<string>;
  password(): Promise<string>;
}

/**
 * Seam for the guided flow (test plan §11 "mock Telegram"): one interactive
 * login (empty StringSession), getMe, the 7.7 channel picker surfaces, and
 * the final session export. close() discards everything (§8 remnants row).
 */
export interface SetupLogin {
  /** Kick off client.start() with the callbacks; resolves once signed in. */
  start(cb: LoginCallbacks): Promise<{ id: number; name: string }>;
  whoAmI(): Promise<{ id: number; name: string }>;
  dialogs(): Promise<SetupChannel[]>;
  /** messages.Search + InputMessagesFilterMusic (limit 1 → total). */
  audioCount(channelId: number): Promise<{ count: number; total: number }>;
  /** One page of messages — verify's channel check (7.8). */
  channelReadable(channelId: number): Promise<boolean>;
  exportSession(): string;
  close(): Promise<void>;
}

export type LoginFactory = (creds: { apiId: number; apiHash: string }) => SetupLogin;

/** A pending login question: promise + the resolver the endpoint calls. */
interface Valve {
  promise: Promise<string>;
  deliver(v: string): void;
  fail(e: Error): void;
}

function makeValve(): Valve {
  let deliverFn: (v: string) => void = () => {};
  let failFn: (e: Error) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    deliverFn = resolve;
    failFn = reject;
  });
  return { promise, deliver: (v) => deliverFn(v), fail: (e) => failFn(e) };
}

/* ---------------------------------------------------------------- manager */

export type VerifySeverity = "ok" | "warn" | "fail";

export interface VerifyRow {
  id: string;
  ok: boolean;
  severity: VerifySeverity;
  detail: string;
  fix?: string;
}

export interface VerifyReport {
  rows: VerifyRow[];
  finishAllowed: boolean;
}

interface DraftOptions {
  allowDownloads: boolean;
  monthlyBytesBudget: number;
  channels: number[];
}

export type LoginPhase = null | "phone" | "code" | "password" | "done";

export interface SetupDeps {
  cfg: Pick<AppConfig, "publicBaseUrl" | "addonSecret" | "addonId" | "monthlyBytesBudget" | "allowDownloads" | "profile">;
  configStore: Pick<ConfigStore, "save">;
  redis: RedisStore | null;
  loginFactory: LoginFactory;
  /** Verified-write callback: swap runtime, SETUP→STANDBY→ACTIVE (7.9). */
  bringUp: (record: StoredConfigV1) => Promise<{ ok: boolean; message?: string }>;
  /** Verify's lease probe (7.8). */
  leaseProbe: () => Promise<{ held: boolean; detail: string }>;
  /** Verify's own-manifest fetch (7.8). Default: real fetch. */
  selfFetcher?: (url: string) => Promise<string | null>;
  /** Login idle window (doc 7.6: 5 min). Tests shrink it. */
  idleMs?: number;
}

const IDLE_MS_DEFAULT = 5 * 60_000;

const defaultSelfFetcher = (url: string): Promise<string | null> =>
  fetch(url)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);

export class SetupManager {
  /** False once finish() succeeded — every /setup/* route then answers 404. */
  closed = false;

  private readonly deps: SetupDeps;
  private readonly idleMs: number;
  private apiId: number | null = null;
  private apiHash: string | null = null;
  private options: DraftOptions;
  /* login lifecycle ------------------------------------------------------- */
  private login: SetupLogin | null = null;
  private user: { id: number; name: string } | null = null;
  private session: string | null = null;
  private loginLoop: Promise<unknown> | null = null;
  private loginPhase: LoginPhase = null;
  private phoneValve: Valve | null = null;
  private codeValve: Valve | null = null;
  private passwordValve: Valve | null = null;
  private sentCodeTo: string | null = null;
  private lastLoginError: SetupError | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastVerify: VerifyReport | null = null;
  private backup: string | null = null; // one-time session reveal (doc §7.4)

  constructor(deps: SetupDeps) {
    this.deps = deps;
    this.idleMs = deps.idleMs ?? IDLE_MS_DEFAULT;
    this.options = {
      allowDownloads: deps.cfg.allowDownloads,
      monthlyBytesBudget: deps.cfg.monthlyBytesBudget,
      channels: [],
    };
  }

  /** Wizard status payload (page polling + minimal FR-33 status). */
  getStatus(): Record<string, unknown> {
    return {
      closed: this.closed,
      creds: this.apiId !== null && this.apiHash !== null,
      loginPhase: this.lastLoginError ? null : this.loginPhase,
      sentCodeTo: this.sentCodeTo,
      loginError: this.lastLoginError
        ? {
            code: this.lastLoginError.code,
            message: this.lastLoginError.message,
            next: this.lastLoginError.next,
            retryAfterSec: this.lastLoginError.retryAfterSec ?? 0,
          }
        : null,
      user: this.user,
      channels: this.options.channels,
      options: { allowDownloads: this.options.allowDownloads, monthlyBytesBudget: this.options.monthlyBytesBudget },
      verify: this.lastVerify,
      publicUrl: this.closed ? `${this.deps.cfg.publicBaseUrl}/${this.deps.cfg.addonSecret}` : null,
      // The page shows the one-time reveal button while a backup is pending.
      backupReady: this.closed && this.backup !== null,
    };
  }

  /* endpoint handlers ------------------------------------------------------ */

  /** POST api/creds — API ID + hash validation (my.telegram.org shape). */
  saveCreds(body: { apiId?: unknown; apiHash?: unknown }): void {
    this.assertOpen();
    const apiId = Number(body.apiId);
    const apiHash = typeof body.apiHash === "string" ? body.apiHash.trim() : "";
    if (!Number.isSafeInteger(apiId) || apiId < 1 || apiId > 2_147_483_647) {
      throw new SetupError("api_id_invalid", "The API ID must be an integer from my.telegram.org", "Re-check the value and retry");
    }
    if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
      throw new SetupError("api_id_invalid", "The API hash must be the 32 hex characters from my.telegram.org", "Re-check the value and retry");
    }
    this.apiId = apiId;
    this.apiHash = apiHash.toLowerCase();
    this.touch();
  }

  /**
   * POST api/login/phone — start (or continue) the login and hand the phone
   * number to the pending client.start() phone callback (doc 7.6).
   */
  async requestLoginCode(phoneRaw: unknown): Promise<void> {
    this.assertOpen();
    if (!(this.apiId !== null && this.apiHash)) {
      throw new SetupError("creds_required", "Save the API ID and hash first", "Go back to the credentials screen", 409);
    }
    const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";
    if (!/^\+?[1-9][0-9]{6,14}$/.test(phone)) {
      throw new SetupError("phone_number_invalid", "That phone number is not valid", "Use international format, for example +977…");
    }
    this.lastLoginError = null;
    if (!this.loginLoop) {
      this.beginStart();
      await this.waitForOrReach("phone"); // first wait: the driver must REACH the phone callback
    }
    if (this.lastLoginError) throw this.lastLoginError; // start failed immediately
    if (this.loginPhase === "phone" && this.phoneValve) {
      this.sentCodeTo = phone;
      this.phoneValve.deliver(phone);
      this.phoneValve = null;
      await this.waitForPhase("phone"); // Telegram responds: ask code or error
    } else if (!this.user || this.loginPhase !== "done") {
      throw new SetupError("login_busy", "A login is already in progress", "Wait for the code screen, then retry", 409);
    }
    if (this.lastLoginError) throw this.lastLoginError;
    this.touch();
  }

  /** POST api/login/code — submit the code to the pending callback. */
  async submitCode(codeRaw: unknown): Promise<void> {
    this.assertOpen();
    const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
    if (!/^[0-9]{1,6}$/.test(code)) {
      throw new SetupError("phone_code_invalid", "The code is wrong or expired", "Request a new code");
    }
    await this.expectPhase("code");
    this.codeValve!.deliver(code);
    this.codeValve = null;
    await this.waitForPhase("code"); // settle → password needed, done, or error
    if (this.loginPhase === "password") {
      // The login parked on the password valve (2FA house). The wizard asks
      // for the 2FA password only when the code POST fails with this code —
      // answering 200 here would be a lie (the login is not done).
      throw new SetupError("password_needed", "Two-step verification is on", "Show the password field");
    }
    if (this.lastLoginError) throw this.lastLoginError;
    this.touch();
  }

  /** POST api/login/password — submit the 2FA password (doc 7.6). */
  async submitPassword(pwRaw: unknown): Promise<void> {
    this.assertOpen();
    const pw = typeof pwRaw === "string" ? pwRaw : "";
    if (pw.length === 0) {
      throw new SetupError("password_invalid", "Wrong password", "Try again — no lockout on our side");
    }
    await this.expectPhase("password");
    this.passwordValve!.deliver(pw);
    this.passwordValve = null;
    await this.waitForPhase("password"); // settle → done or error
    if (this.lastLoginError) throw this.lastLoginError;
    this.touch();
  }

  /** GET api/channels — dialogs filtered to channels/groups (doc 7.7). */
  async listChannels(): Promise<SetupChannel[]> {
    this.assertOpen();
    await this.requireLogin();
    const list = await this.login!.dialogs();
    this.touch();
    return list;
  }

  /** POST api/channels/count — on-demand audio count for one channel (7.7). */
  async audioCount(idRaw: unknown): Promise<{ id: number; count: number; total: number }> {
    this.assertOpen();
    await this.requireLogin();
    const id = Number(idRaw);
    if (!Number.isSafeInteger(id) || id > -100) {
      throw new SetupError("bad_channel", "Pick one of the listed channels", "Use the ids from the channels screen");
    }
    const out = await this.login!.audioCount(id);
    this.touch();
    return { id, count: out.count, total: out.total };
  }

  /** POST api/options — chosen channels + download/budget options. */
  saveOptions(body: { allowDownloads?: unknown; monthlyBytesBudget?: unknown; channels?: unknown }): void {
    this.assertOpen();
    const allowDownloads = body.allowDownloads === undefined ? this.options.allowDownloads : body.allowDownloads === true;
    const budget = Number(body.monthlyBytesBudget ?? this.options.monthlyBytesBudget);
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 1_000_000_000_000) {
      throw new SetupError("bad_options", "The monthly budget must be a plain byte count", "0 means unlimited; for example 4500000000 for 4.5 GB");
    }
    const channels = Array.isArray(body.channels) ? (body.channels as unknown[]) : this.options.channels;
    if (!channels.every((c) => typeof c === "number" && Number.isSafeInteger(c) && c <= -100)) {
      throw new SetupError("bad_options", "Channel ids look wrong", "Select the checkboxes on the channels screen");
    }
    this.options = { allowDownloads, monthlyBytesBudget: budget, channels: channels as number[] };
    this.touch();
  }

  /** POST api/verify — the doc 7.8 checks. */
  async verify(): Promise<VerifyReport> {
    this.assertOpen();
    await this.requireLogin();
    if (this.options.channels.length === 0) {
      throw new SetupError("channels_required", "Select at least one channel", "Go back to the channels screen", 409);
    }
    const rows: VerifyRow[] = [];
    await this.verifyRedis(rows);
    await this.verifyTelegram(rows);
    await this.verifyChannels(rows);
    await this.verifyAudio(rows);
    await this.verifyPublicUrl(rows);
    await this.verifyLease(rows);

    const finishAllowed = rows.every((r) => r.severity !== "fail");
    this.lastVerify = { rows, finishAllowed };
    this.touch();
    return this.lastVerify;
  }

  /** POST api/finish — persist (7.9.1), swap (7.9.2/3), close (7.9.4). */
  async finish(): Promise<{ publicUrl: string }> {
    this.assertOpen();
    if (!this.session || !this.apiId || !this.apiHash) {
      throw new SetupError("login_required", "The login is not complete", "Go back to the login screen", 409);
    }
    if (this.options.channels.length === 0) {
      throw new SetupError("channels_required", "Select at least one channel", "Go back to the channels screen", 409);
    }
    if (!this.lastVerify?.finishAllowed) {
      throw new SetupError("verify_required", "Run the checks again", "Press verify — every red row has to clear", 409);
    }
    this.touch();
    const record: StoredConfigV1 = {
      v: 1,
      apiId: this.apiId,
      apiHash: this.apiHash,
      sessions: [this.session],
      channels: this.options.channels,
      options: { allowDownloads: this.options.allowDownloads, monthlyBytesBudget: this.options.monthlyBytesBudget },
      updatedAt: new Date().toISOString(),
    };
    await this.deps.configStore.save(record); // verified write — throws on mismatch
    const outcome = await this.deps.bringUp(record);
    if (!outcome.ok) {
      throw new SetupError("startup_pending", outcome.message ?? "The service is still switching over", "Give it a few seconds, then retry", 503);
    }
    this.closed = true; // 7.9.4 — the setup site is closed from here on
    this.backup = record.sessions[0] ?? null; // doc §7.4 — backup on the final screen
    await this.discardLogin(false); // §8 memory remnants cleared
    this.lastVerify = null;
    return { publicUrl: `${this.deps.cfg.publicBaseUrl}/${this.deps.cfg.addonSecret}` };
  }

  /**
   * Session backup (doc §7.4): the deploy-log token reveals the finished
   * session string exactly once, so it can be saved as TELEGRAM_SESSION_STRING
   * against a free Redis plan losing data. Only after finish; never twice.
   */
  revealBackup(): { session: string } {
    if (this.backup === null || !this.closed) {
      throw new SetupError(
        this.closed ? "gone" : "closed",
        this.closed ? "The backup was already revealed — it is never shown twice" : "Setup has not finished yet",
        this.closed ? "Redeploy to re-run the wizard, then boot from TELEGRAM_SESSION_STRING" : "Finish the wizard first",
        404,
      );
    }
    const session = this.backup;
    this.backup = null; // doc §7.4 — "reveal the session string once"
    return { session };
  }

  /** Full teardown (CPU-shutdown path in main too). */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    await this.discardLogin(false);
    this.closed = true;
  }

  /* internals --------------------------------------------------------------- */

  private assertOpen(): void {
    if (this.closed) throw new SetupError("closed", "Setup already finished", "The setup site is closed", 404);
  }

  private async requireLogin(): Promise<SetupLogin> {
    if (!this.login || !this.session) {
      throw new SetupError("login_required", "Finish the Telegram login first", "Go back to the login screen", 409);
    }
    return this.login;
  }

  /** Idle timer: any endpoint activity defers the discard (traffic keeps awake). */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.onIdle(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private onIdle(): void {
    void this.discardLogin(true);
  }

  /**
   * Discard the whole login state (§8 memory remnants): client closed, valves
   * rejected so nothing hangs, errors surfaced with the doc's idle wording.
   */
  private async discardLogin(idle: boolean): Promise<void> {
    this.loginPhase = null;
    this.sentCodeTo = null;
    this.user = null;
    this.session = null;
    this.loginLoop = null;
    for (const v of [this.phoneValve, this.codeValve, this.passwordValve]) v?.fail(idle ? IDLE_ERROR : new SetupError("login_reset", "The login was reset", "Start again from the phone screen", 409));
    this.phoneValve = null;
    this.codeValve = null;
    this.passwordValve = null;
    if (idle) this.lastLoginError = IDLE_ERROR;
    const login = this.login;
    this.login = null;
    await login?.close().catch(() => undefined);
  }

  /** Create the login and start client.start() with resolver-valve callbacks. */
  private beginStart(): void {
    const login = this.deps.loginFactory({ apiId: this.apiId!, apiHash: this.apiHash! });
    this.login = login;
    this.touch();
    const cb: LoginCallbacks = {
      phone: () => {
        this.phoneValve = makeValve();
        this.loginPhase = "phone";
        return this.phoneValve.promise;
      },
      code: () => {
        this.codeValve = makeValve();
        this.loginPhase = "code";
        return this.codeValve.promise;
      },
      password: () => {
        this.passwordValve = makeValve();
        this.loginPhase = "password";
        return this.passwordValve.promise;
      },
    };
    this.loginLoop = login
      .start(cb)
      .then((ok) => {
        this.user = ok;
        this.session = login.exportSession();
        this.loginPhase = "done";
        this.touch();
      })
      .catch((e: unknown) => {
        this.lastLoginError = mapLoginError(e);
        void this.discardLogin(false);
      });
  }

  /**
   * Poll (2 ms) until the login advanced past `phase` — a later callback was
   * invoked, the login finished, or it errored. Caps at ~2 s (Telegram send
   * code behaves synchronously in both real GramJS and the mock).
   */
  private async waitForPhase(phase: LoginPhase): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (this.loginPhase !== phase || this.lastLoginError || this.loginPhase === "done") return;
      await delay(2);
    }
  }

  /** Same as waitForPhase but errors when not currently AT `phase` at all. */
  private async expectPhase(phase: Exclude<LoginPhase, null | "done">): Promise<void> {
    if (this.lastLoginError) throw this.lastLoginError;
    await this.waitForOrReach(phase);
    if (!this.codeValveHas(phase)) {
      throw new SetupError(
        phase === "code" ? "unexpected_code" : "unexpected_password",
        phase === "code" ? "No code is being awaited right now" : "No password is needed",
        "Use the phone screen to restart the login",
        409,
      );
    }
  }

  private codeValveHas(phase: Exclude<LoginPhase, null | "done">): boolean {
    return phase === "code" ? this.codeValve !== null : this.passwordValve !== null;
  }

  /** Poll until AT `phase` — includes waiting for the initial callback. */
  private async waitForOrReach(phase: Exclude<LoginPhase, null | "done">): Promise<void> {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (this.loginPhase === phase || this.lastLoginError) return;
      await delay(2);
    }
  }

  /* verify helpers (7.8) ----------------------------------------------------- */

  private async verifyRedis(rows: VerifyRow[]): Promise<void> {
    if (!this.deps.redis) return; // without Redis the verify screen says so via lease row
    const t0 = Date.now();
    try {
      await this.deps.redis.readConfigBlob();
      rows.push({ id: "redis", ok: true, severity: "ok", detail: `ping ${Date.now() - t0} ms` });
    } catch {
      rows.push({
        id: "redis",
        ok: false,
        severity: "warn",
        detail: "Redis unreachable — flood cooldowns and the index snapshot stay local",
        fix: "Check REDIS_URL; on Render follow the session backup steps",
      });
    }
  }

  private async verifyTelegram(rows: VerifyRow[]): Promise<void> {
    try {
      const who = await this.login!.whoAmI();
      rows.push({ id: "telegram", ok: true, severity: "ok", detail: who.name });
    } catch (e) {
      const mapped = mapLoginError(e);
      rows.push({ id: "telegram", ok: false, severity: "fail", detail: mapped.message, fix: "Return to the login screen" });
    }
  }

  /** 7.8 channels row: each chosen channel returns a page of messages. */
  private async verifyChannels(rows: VerifyRow[]): Promise<void> {
    for (const id of this.options.channels) {
      try {
        const readable = await this.login!.channelReadable(id);
        if (readable) rows.push({ id: "channels", ok: true, severity: "ok", detail: `channel ${id} readable` });
        else rows.push({ id: "channels", ok: false, severity: "fail", detail: `channel ${id} unreachable`, fix: "Join the channel with this account, or remove it" });
      } catch {
        rows.push({ id: "channels", ok: false, severity: "fail", detail: `channel ${id} unreadable`, fix: "The channel may be protected — join it first or remove it" });
      }
    }
  }

  private async verifyAudio(rows: VerifyRow[]): Promise<void> {
    const parts: string[] = [];
    let audioOk = false;
    for (const id of this.options.channels) {
      try {
        const c = await this.login!.audioCount(id);
        parts.push(`channel ${id}: ${c.count} audio`);
        if (c.count > 0) audioOk = true;
      } catch {
        parts.push(`channel ${id}: unavailable`);
      }
    }
    rows.push(
      audioOk
        ? { id: "audio", ok: true, severity: "ok", detail: parts.join("; ") }
        : {
            id: "audio",
            ok: false,
            severity: "warn",
            detail: `no audio found by the music filter (${parts.join("; ")})`,
            fix: "Check it is the right channel — FLAC sent as plain documents may not match the filter",
          },
    );
  }

  private async verifyPublicUrl(rows: VerifyRow[]): Promise<void> {
    const url = `${this.deps.cfg.publicBaseUrl}/${this.deps.cfg.addonSecret}/manifest.json`;
    let body: string | null = null;
    try {
      body = await (this.deps.selfFetcher ?? defaultSelfFetcher)(url);
    } catch {
      body = null;
    }
    let ok = false;
    if (body) {
      try {
        ok = (JSON.parse(body) as { id?: string }).id === this.deps.cfg.addonId;
      } catch {
        ok = false;
      }
    }
    rows.push(
      ok
        ? { id: "public_url", ok: true, severity: "ok", detail: this.deps.cfg.publicBaseUrl }
        : {
            id: "public_url",
            ok: false,
            severity: "fail",
            detail: "the manifest is not reachable under PUBLIC_BASE_URL",
            fix: "Set PUBLIC_BASE_URL to https://<service>.onrender.com (or RENDER_EXTERNAL_URL)",
          },
    );
  }

  private async verifyLease(rows: VerifyRow[]): Promise<void> {
    const lease = await this.deps.leaseProbe();
    if (lease.held) rows.push({ id: "lease", ok: true, severity: "ok", detail: lease.detail });
    else rows.push({ id: "lease", ok: false, severity: "fail", detail: lease.detail, fix: "Wait for the other instance to drain, then retry" });
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------- page */

/**
 * The wizard page (doc 7.5/§9): one self-contained HTML file — inline
 * `<style>`+`<script>` bound to a per-request nonce(CSP default-src 'none',
 * connect-src 'self', frame-ancestors 'none'), mobile-first 360 px, plain
 * DOM textContent writes only (§8 XSS row), no external requests (§10).
 * Screens: welcome → creds → login → channels → options → verify → done.
 */
export function renderSetupPage(nonce: string): string {
  /* No `${` sequences inside the template (avoid TS interpolation hazards in
   * the page script); backticks avoided for the same reason. */
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MystoTune setup</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;margin:auto;padding:16px;max-width:520px;background:#111;color:#eee}
a{color:#7bf}h1{font-size:1.25rem}h2{font-size:1.05rem;margin:.4rem 0}
input{width:100%;font-size:1rem;padding:10px;margin:6px 0;border-radius:8px;border:1px solid #444;background:#1c1c1c;color:#eee}
button{font-size:1rem;padding:10px 14px;border-radius:8px;border:0;background:#4c7;color:#111;margin:6px 0;width:100%}
button:disabled{opacity:.4}.hint{color:#9ab;font-size:.85rem}.banner{background:#333;padding:8px;border-radius:8px;font-size:.85rem;margin-bottom:12px}
.row{display:flex;gap:8px;align-items:center;padding:6px;border-bottom:1px solid #333}.row input[type=checkbox]{width:auto}
.row span{flex:1}.cnt{color:#9ab;font-size:.8rem}.tick{color:#5c5}.fail{color:#e55}.warn{color:#fb5}
.hidden{display:none}label{display:block;margin-top:10px}code{word-break:break-all}ol li{margin:6px 0}
</style></head><body>
<div class="banner">This page signs in to a Telegram account. Use a <b>dedicated</b> account that has joined your music channels.</div>
<section id="s-welcome"><h1>Welcome</h1><p>This wizard connects your Telegram music channels to BitChord.</p><ol>
<li>A dedicated Telegram account that has joined your music channels</li>
<li>An API ID and hash from <a href="https://my.telegram.org" rel="noreferrer">my.telegram.org</a></li></ol>
<label>API ID<input id="api-id" inputmode="numeric" placeholder="1234567" autocomplete="off"></label>
<label>API hash<input id="api-hash" placeholder="32 hex characters" autocomplete="off"></label>
<button id="b-creds">Continue</button><p id="w-err" class="hint"></p></section>
<section id="s-login" class="hidden"><h1>Telegram login</h1><p id="l-step" class="hint"></p>
<label>Phone number<input id="l-phone" inputmode="tel" placeholder="+97799…"></label><button id="b-phone">Send code</button>
<div id="code-row" class="hidden"><label>Code<input id="l-code" inputmode="numeric" placeholder="12345"></label><button id="b-code">Check code</button></div>
<div id="pw-row" class="hidden"><label>2FA password<input id="l-pw" type="password"></label><button id="b-pw">Unlock</button></div>
<p id="l-err" class="hint"></p></section>
<section id="s-channels" class="hidden"><h1>Channels</h1><div id="ch-list"></div><p id="ch-note" class="hint"></p><button id="b-channels">Continue</button></section>
<section id="s-options" class="hidden"><h1>Options</h1><p>Preset: downloads on · unlimited monthly bandwidth · downloads are tuned for Render's free plan.</p>
<label><input id="o-dl" type="checkbox" checked> allow file downloads</label>
<label>Monthly bytes budget (0 = unlimited)<input id="o-budget" inputmode="numeric" value="0"></label>
<button id="b-options">Verify</button><p id="o-err" class="hint"></p></section>
<section id="s-verify" class="hidden"><h1>Verify</h1><div id="v-rows"></div><button id="b-verify">Run checks</button><button id="b-finish" class="hidden">Finish setup</button><p id="v-err" class="hint"></p></section>
<section id="s-done" class="hidden"><h1>Done</h1><p>Add the addon in BitChord: <b>Settings → Sources → Add an addon</b></p>
<code id="d-url"></code><p><button id="b-copy" class="hidden" style="width:auto;padding:6px 12px">Copy URL</button></p>
<p><button id="b-session" class="hidden" style="width:auto;padding:6px 12px">Reveal session backup</button></p>
<code id="d-session" class="hidden"></code>
<p id="d-err" class="hint"></p>
<p class="hint">Reveal the session string once and save it as TELEGRAM_SESSION_STRING in Render — a free Redis plan can lose data. Setup is now closed.</p></section>
<script nonce="${nonce}">"use strict";
var csrf=null;
var tok=null;
var S={welcome:"s-welcome",login:"s-login",channels:"s-channels",options:"s-options",verify:"s-verify",done:"s-done"};
var base=location.pathname.replace(/\\/$/,"")+"/api/";
function $(i){return document.getElementById(i)}
function setk(k){for(var n in S){$(S[n]).className=n===k?"":"hidden"}}
function msg(id,txt){$(id).textContent=txt||""}
/** JSON API helper: always same-origin POST with the CSRF double submit. */
function rq(p,body){
  var h={"x-setup-csrf":csrf||""};
  if(body){h["content-type"]="application/json"}
  return fetch(base+p,{method:body?"POST":"GET",credentials:"same-origin",headers:h,body:body?JSON.stringify(body):undefined})
    .then(function(r){return r.json().then(function(j){return{r:r,j:j}},function(){return{r:r,j:null}})})
    .then(function(o){
      if(!o.r.ok||(o.j&&o.j.ok===false)){var j=o.j||{};var e=new Error(j.message||("HTTP "+o.r.status));
        e.next=j.next||"";e.code=j.code||"";e.retryAfterSec=j.retryAfterSec||0;e.remaining=j.remaining||0;throw e}
      return o.j})}
// 1. unwrap the fragment token, exchange for the cookie, strip from history
(function(){var m=/[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash||"");
  if(!m){$("b-creds").disabled=true;msg("w-err","Open the setup link from the deploy logs — it ends in #t=…");return}
  history.replaceState(null,"",location.pathname);
  tok=m[1];
  rq("unlock",{token:m[1]}).then(function(u){csrf=u.csrf},function(e){$("b-creds").disabled=true;msg("w-err","Unlock failed: "+e.message)})})();
// 2. creds
$("b-creds").onclick=function(){msg("w-err");
  rq("creds",{apiId:$("api-id").value.trim(),apiHash:$("api-hash").value.trim()})
    .then(function(){setk("login")},function(e){msg("w-err",e.message+(e.next?" — "+e.next:""))})};
// 3. login: phone → code → password (server messages follow the doc table)
$("b-phone").onclick=function(){msg("l-err");
  rq("login/phone",{phone:$("l-phone").value.trim()})
    .then(function(){$("code-row").className="";$("l-step").textContent="Code sent — check Telegram";$("b-phone").disabled=false},
      function(e){$("b-phone").disabled=false;msg("l-err",e.message+(e.next?" — "+e.next:""))})};
$("b-code").onclick=function(){msg("l-err");$("b-code").disabled=true;
  rq("login/code",{code:$("l-code").value.trim()})
    .then(function(){setk("channels");loadChannels()},
      function(e){$("b-code").disabled=false;
        if(e.code==="password_needed"){$("code-row").className="hidden";$("pw-row").className=""}
        msg("l-err",e.message+(e.next?" — "+e.next:""))})};
$("b-pw").onclick=function(){msg("l-err");
  rq("login/password",{password:$("l-pw").value})
    .then(function(){setk("channels");loadChannels()},function(e){msg("l-err",e.message+(e.next?" — "+e.next:""))})};
var channels=[];
// 4. channel picker (doc 7.7): dialogs + on-demand audio counts
function loadChannels(){msg("ch-note","Loading channels…");
  rq("channels").then(function(list){
    var box=$("ch-list");box.textContent="";channels=[];
    if(!list.length){msg("ch-note","No channels or groups found for this account.");return}
    list.forEach(function(ch){
      var row=document.createElement("div");row.className="row";
      var cb=document.createElement("input");cb.type="checkbox";cb.value=String(ch.id);cb.setAttribute("data-audio","?");
      var span=document.createElement("span");span.textContent=ch.title;
      var cnt=document.createElement("span");cnt.className="cnt";cnt.textContent="";
      var eb=document.createElement("button");eb.className="cnt";eb.style.width="auto";eb.style.padding="2px 8px";eb.textContent="Count";
      eb.onclick=function(){eb.disabled=true;cnt.textContent="…";
        rq("channels/count",{id:Number(cb.value)}).then(function(c){cnt.textContent=c.count+" audio"},
          function(e){cnt.textContent="?"})};
      row.appendChild(cb);row.appendChild(span);row.appendChild(eb);row.appendChild(cnt);box.appendChild(row);
      channels.push(ch);
    });
    msg("ch-note","Zero audio is a warning only — FLAC sent as a document may not match the music filter.");
  },function(e){msg("ch-note","Could not load channels: "+e.message)})}
$("b-channels").onclick=function(){var ids=[];
  document.querySelectorAll("#ch-list input[type=checkbox]:checked").forEach(function(cb){ids.push(Number(cb.value))});
  if(!ids.length){msg("ch-note","Select at least one channel.");return}
  setk("options")};
// 5. options → 6. verify (server runs the doc 7.8 checks)
$("b-options").onclick=function(){
  var raw=$("o-budget").value.trim();var budget=raw===""?0:Number(raw);
  if(!Number.isSafeInteger(budget)||budget<0){msg("o-err","Monthly budget must be a whole byte count (0 = unlimited).");return}
  msg("");
  rq("options",{allowDownloads:$("o-dl").checked,monthlyBytesBudget:budget,channels:selectedIds()})
    .then(function(){setk("verify")},function(e){msg("o-err",e.message+(e.next?" — "+e.next:""))})};
function selectedIds(){return channels.map(function(c){return c.id}).length&&Array.from(document.querySelectorAll("#ch-list input[type=checkbox]:checked")).map(function(cb){return Number(cb.value)})}
$("b-verify").onclick=function(){msg("v-err");$("b-verify").disabled=true;
  rq("verify",{}).then(function(rep){
    var box=$("v-rows");box.textContent="";
    rep.rows.forEach(function(row){var li=document.createElement("div");li.className="row";
      var t=document.createElement("span");
      t.textContent=row.ok?"✓ "+row.detail:((row.severity==="warn"?"⚠ ":"✗ ")+row.detail+(row.fix?" — "+row.fix:""));
      if(!row.ok)t.className=row.severity==="warn"?"warn":"fail";
      li.appendChild(t);box.appendChild(li)});
    $("b-finish").className=rep.finishAllowed?"":"hidden";
    $("b-verify").disabled=false;msg("v-err","")},
    function(e){$("b-verify").disabled=false;msg("v-err",e.message+(e.next?" — "+e.next:""))})};
// 7. finish: verified persist + STANDBY→ACTIVE swap, then the site closes
$("b-finish").onclick=function(){msg("v-err");$("b-finish").disabled=true;
  rq("finish",{}).then(function(out){$("d-url").textContent=out.publicUrl;setk("done");
    $("b-copy").className="";
    $("b-copy").onclick=function(){try{navigator.clipboard.writeText(out.publicUrl)}catch(e){}}
    if(tok)$("b-session").className="";},
    function(e){$("b-finish").disabled=false;msg("v-err",e.message+(e.next?" — "+e.next:""))})};
// 8. one-time session backup (doc §7.4): token required, shown exactly once
$("b-session").onclick=function(){
  fetch(base+"session",{headers:{"x-setup-token":tok||""}})
    .then(function(r){return r.json().then(function(j){return{r:r,j:j}},function(){return{r:r,j:null}})})
    .then(function(o){var j=o.j||{};
      if(o.r.ok&&j.ok){$("d-session").textContent=j.session;$("d-session").className="";$("b-session").className="hidden";
        msg("d-err","Copy it now — it is never shown again.")}
      else{$("b-session").className="hidden";msg("d-err",j.message||("HTTP "+o.r.status))}})};
</script>
<noscript>This page needs JavaScript.</noscript></body></html>`;
}
