/**
 * M7.0: typed discovery grammar for /search (v0.7.0-discovery).
 *
 * BitChord sends `q` to the addon byte-intact (its own AddonSourceTest asserts
 * the verbatim wire round-trip), so the grammar lives entirely client-free:
 *
 *   artist:adele        artist:"depeche mode"    — artist column match
 *   album:"back to black" album:go               — album column match
 *   title:control                                  — title column match
 *   "midnight city"      quoted PHRASE — token adjacency (any column)
 *   lossless                                      — lossless-only filter
 *   dur:>=300  dur:<180  dur:200                  — duration window (op optional, default =)
 *   recent:7d   recent:30                         — added within the last N days
 *   sort:relevance|recent|oldest|longest           — result order (default relevance)
 *
 * Degradation rules (never crash, never surprise):
 *   unknown `foo:bar` prefix stays free text (legacy keyword behavior);
 *   a known prefix with a junk value ("dur:soon") is dropped, never injected
 *   into the result set; quoted spans survive as single shared terms.
 */

export type SortMode = "relevance" | "recent" | "oldest" | "longest";
export type DurOp = ">=" | ">" | "<=" | "<" | "=";

export interface ParsedQuery {
  free: string;
  phrases: string[];
  artist: string[];
  album: string[];
  title: string[];
  lossless: boolean;
  durOp: DurOp | null;
  durVal: number | null;
  recentDays: number | null;
  /** true when an explicit sort: token was present (browse intent when no terms) */
  sorted: boolean;
  sort: SortMode;
}

/** Single-char marker wrapping a pool index; survives the whitespace split. */
const MARKER = "\u0000";
const MARKER_RE = /^\u0000(\d+)\u0000$/;
const OP_RE = /^(artist|album|title|dur|recent|sort):([\s\S]+)$/i;

/** Parse the raw q string into a structured query. Total function: any input
 * (empty, hostile, unbalanced quotes) yields a usable ParsedQuery. */
export function parseQuery(raw: string | undefined | null): ParsedQuery {
  const q: ParsedQuery = {
    free: "",
    phrases: [],
    artist: [],
    album: [],
    title: [],
    lossless: false,
    durOp: null,
    durVal: null,
    recentDays: null,
    sorted: false,
    sort: "relevance",
  };
  if (!raw) return q;

  /* Quoted spans first: rewrite for the shared pool and replace with a digit
   * marker so `artist:"depeche mode"` stays one whitespace token. */
  const pool: string[] = [];
  const rest = raw.replace(/"([^"]*)"/g, (_m, p: string) => {
    pool.push(p);
    return MARKER + String(pool.length - 1) + MARKER;
  });

  const free: string[] = [];
  for (const tok of rest.split(/\s+/)) {
    if (!tok) continue;
    if (tok.toLowerCase() === "lossless") {
      q.lossless = true;
      continue;
    }
    const m = OP_RE.exec(tok);
    if (!m) {
      const ph = poolOf(tok, pool);
      if (ph !== null) {
        if (ph.trim()) q.phrases.push(ph); // bare "…" → adjacency in any column
      } else free.push(tok); // plain word — legacy keyword behavior
      continue;
    }
    const kind = (m[1] ?? "").toLowerCase();
    let val = m[2] ?? "";
    const ph = poolOf(val, pool);
    if (ph !== null) val = ph;
    switch (kind) {
      case "artist":
        if (val) q.artist.push(val);
        break;
      case "album":
        if (val) q.album.push(val);
        break;
      case "title":
        if (val) q.title.push(val);
        break;
      case "dur": {
        const d = /^(>=|<=|>|<|=)?(\d+)$/.exec(val);
        if (d) {
          q.durOp = (d[1] ?? "=") as DurOp;
          q.durVal = Number(d[2] ?? "0");
        }
        break;
      }
      case "recent": {
        const r = /^(\d+)d?$/.exec(val);
        const n = Number(r?.[1] ?? "0");
        if (n >= 1) q.recentDays = Math.min(n, 3650); // 0 days = empty window — drop
        break;
      }
      case "sort": {
        const s = val.toLowerCase();
        if (s === "relevance" || s === "recent" || s === "oldest" || s === "longest") {
          q.sort = s;
          q.sorted = true;
        }
        break;
      }
    }
  }
  q.free = free.join(" ");
  return q;
}

/** Exact phrase-marker token/value → its original quoted span, else null. */
function poolOf(s: string, pool: string[]): string | null {
  const m = MARKER_RE.exec(s);
  if (!m) return null;
  return pool[Number(m[1] ?? "")] ?? null;
}

/** True when the query carries anything beyond plain free text. */
export function isStructured(q: ParsedQuery): boolean {
  return (
    q.phrases.length > 0 ||
    q.artist.length > 0 ||
    q.album.length > 0 ||
    q.title.length > 0 ||
    q.lossless ||
    q.durVal !== null ||
    q.recentDays !== null ||
    q.sorted ||
    q.sort !== "relevance"
  );
}
