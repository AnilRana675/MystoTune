/**
 * Minimal in-process RESP2 Redis for the M3 suite: no network dependency.
 * Supports the exact command subset src/redis.ts uses (PING/GET/SET/SETEX/
 * EXPIRE/INCR/INCRBY/DEL) with binary-safe bulk payloads and lazily-swept
 * expiries.
 */
import net from "node:net";

export interface FakeRedisEntry {
  value: Buffer;
  /** null = never expires; else absolute epoch ms */
  expAt: number | null;
}

export interface FakeRedisServer {
  port: number;
  url: string;
  data: Map<string, FakeRedisEntry>;
  /** number of commands the server answered */
  commands: number;
  stop(): Promise<void>;
}

interface Writer {
  sock: net.Socket;
  buf: Buffer;
}

/** Parse one RESP value; return [value, nextOffset] or null if incomplete. */
function parseResp(buf: Buffer, offset: number): [unknown, number] | null {
  if (offset >= buf.length) return null;
  const nl = buf.indexOf("\n", offset);
  if (nl < 0) return null;
  const kindByte = buf[offset];
  if (kindByte === undefined) return null;
  const kind = String.fromCharCode(kindByte);
  const head = buf.subarray(offset + 1, nl).toString("utf8");
  if (kind === "*") {
    const count = Number(head);
    if (!Number.isInteger(count) || count < 0) return null;
    let pos = nl + 1;
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const next = parseResp(buf, pos);
      if (!next) return null;
      items.push(next[0]);
      pos = next[1];
    }
    return [items, pos];
  }
  if (kind === "$") {
    const len = Number(head);
    if (!Number.isInteger(len)) return null;
    if (len === -1) return [null, nl + 1];
    const end = nl + 1 + len;
    if (buf.length < end + 2) return null;
    return [buf.subarray(nl + 1, end), end + 2]; // skip trailing \r\n
  }
  return null; // requests are always bulk arrays from ioredis
}

function isLive(e: FakeRedisEntry | undefined, now: number): boolean {
  return !!e && (e.expAt === null || e.expAt > now);
}

export async function startFakeRedis(): Promise<FakeRedisServer> {
  const data = new Map<string, FakeRedisEntry>();
  let commands = 0;
  const writers = new Set<Writer>();

  const write = (w: Writer, token: string | number | Buffer): void => {
    if (Buffer.isBuffer(token)) {
      w.sock.write(`$${token.length}\r\n`);
      w.sock.write(token);
      w.sock.write("\r\n");
    } else if (typeof token === "number") {
      w.sock.write(`:${token}\r\n`);
    } else if (token.startsWith("!")) {
      w.sock.write(`-${token.slice(1)}\r\n`);
    } else {
      w.sock.write(`+${token}\r\n`);
    }
  };

  const handle = (w: Writer, tokens: unknown[]): void => {
    const now = Date.now();
    const name = String(tokens[0] ?? "").toUpperCase();
    const argv: Buffer[] = tokens.slice(1).map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v))));
    switch (name) {
      case "PING":
        write(w, "PONG");
        return;
      case "INFO":
        // ioredis handshakes with INFO; must be a bulk string
        write(w, Buffer.from("# Server\r\nredis_version:7.2.0\r\nrole:master\r\n"));
        return;
      case "GET": {
        const key = argv[0]?.toString("utf8") ?? "";
        const e = data.get(key);
        if (!isLive(e, now)) {
          data.delete(key);
          w.sock.write("$-1\r\n");
        } else {
          write(w, e!.value);
        }
        return;
      }
      case "SET": {
        const key = argv[0]?.toString("utf8") ?? "";
        const tail = tokens.slice(3).map((t) => (Buffer.isBuffer(t) ? t.toString("utf8") : String(t)));
        let expAt: number | null = null;
        for (let i = 0; i < tail.length; i++) {
          const opt = tail[i]?.toUpperCase();
          const n = Number(tail[i + 1]);
          if (opt === "EX" && Number.isFinite(n)) {
            expAt = now + n * 1000;
            i += 1;
          } else if (opt === "PX" && Number.isFinite(n)) {
            expAt = now + n;
            i += 1;
          }
        }
        data.set(key, { value: Buffer.from(argv[1] ?? Buffer.alloc(0)), expAt });
        write(w, "OK");
        return;
      }
      case "SETEX": {
        const key = argv[0]?.toString("utf8") ?? "";
        const seconds = Number(argv[1]?.toString("utf8"));
        data.set(key, {
          value: Buffer.from(argv[2] ?? Buffer.alloc(0)),
          expAt: now + seconds * 1000,
        });
        write(w, "OK");
        return;
      }
      case "EXPIRE": {
        const key = argv[0]?.toString("utf8") ?? "";
        const seconds = Number(argv[1]?.toString("utf8"));
        const e = data.get(key);
        if (!isLive(e, now)) {
          data.delete(key);
          write(w, 0);
        } else {
          e!.expAt = now + seconds * 1000;
          write(w, 1);
        }
        return;
      }
      case "INCR":
      case "INCRBY": {
        const key = argv[0]?.toString("utf8") ?? "";
        const by = name === "INCRBY" ? Number(argv[1]?.toString("utf8")) || 0 : 1;
        const e = data.get(key);
        if (!isLive(e, now)) {
          data.set(key, { value: Buffer.from(String(by), "utf8"), expAt: null });
          write(w, by);
        } else {
          const n = Number(e!.value.toString("utf8"));
          if (!Number.isFinite(n)) {
            write(w, "!ERR value is not an integer or out of range");
            return;
          }
          e!.value = Buffer.from(String(n + by), "utf8");
          write(w, n + by);
        }
        return;
      }
      case "DEL": {
        let n = 0;
        for (const a of argv) {
          if (data.delete(a.toString("utf8"))) n += 1;
        }
        write(w, n);
        return;
      }
      case "QUIT":
        w.sock.write("+OK\r\n");
        w.sock.end();
        return;
      default:
        write(w, `!ERR unknown command '${name}'`);
    }
  };

  const server = net.createServer((sock) => {
    const w: Writer = { sock, buf: Buffer.alloc(0) };
    writers.add(w);
    sock.on("data", (chunk: Buffer) => {
      w.buf = Buffer.concat([w.buf, chunk]);
      let offset = 0;
      for (;;) {
        const next = parseResp(w.buf, offset);
        if (!next) break;
        const [value, pos] = next;
        offset = pos;
        if (Array.isArray(value)) {
          commands += 1;
          handle(w, value);
        }
      }
      if (offset > 0) w.buf = w.buf.subarray(offset);
    });
    sock.on("error", () => undefined);
    sock.on("close", () => writers.delete(w));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  const stop = async (): Promise<void> => {
    for (const w of writers) w.sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, url: `redis://127.0.0.1:${port}`, data, commands, stop };
}
