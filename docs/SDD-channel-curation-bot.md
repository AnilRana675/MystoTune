# SDD — MystoTune Channel Curation Bot (Bot MVP)

Version 0.2 · drafted from owner interview (2026-10-24). Owner's words:
"bot is only for organizing the channel music files … only me … cleaning
channel or junk files, check duplicates", "bot does not contain any commands,
so bot does all automatically, bot only asks me should I delete or keep, or
which one keep or delete".

## 1. Purpose

A private, **zero-command** Telegram bot that continuously watches the music
channel's index and pushes review cards to the owner: junk candidates and
duplicate groups. Every destructive action waits for a button tap:
**Delete or Keep** for junk, **"Keep this one"** for duplicate groups
(deleting the others). The bot never deletes without an explicit tap.

## 2. Locked decisions (from the interview)

| Decision | Value |
| --- | --- |
| Surface | **No commands.** Findings are pushed as review cards with inline buttons |
| Automation | Sweeps run automatically: once at bot start (after the first sync) and then on a fixed interval |
| Audience | Owner only — `BOT_ALLOWED_IDS` (comma list of Telegram user ids, first id = the chat cards are sent to); strangers' taps/buttons are ignored |
| Decision UI | Per-card inline keyboards: junk = `Delete` / `Keep`; duplicate group = `Keep #1` / `Keep #2` / `Skip`; every card single-use |
| Deletion authority | The **user session** (owner's logged-in account in `src/telegram.ts`) performs `deleteMessages`; the bot account only coordinates (bots cannot delete channel messages) |
| Transport | Bot API HTTPS long polling (outbound-only; no webhook/port/cert; fine on Render free + selfhost) |
| Dependency budget | Zero new npm deps — raw `fetch` to `https://api.telegram.org/bot<token>/*` |
| Durable review state | New SQLite table `bot_review` (kind, payload, verdict, asked/answered timestamps). Answered cards are never re-asked after restarts; pending ones are re-asked on the next sweep |
| Token | `BOT_TOKEN` env (BotFather). Empty → bot disabled, addon 100% unaffected |
| Failure stance | §4.11 rule 3: boot never depends on the bot; poller crashes reconnect with backoff and are logged |

## 3. Data sources

- **The index is the audit database.** All scan/dedupe logic reads `tracks`
  (SQLite, existing FTS + columns: title/artist/duration/mime/size/docId/msgId)
  — no re-crawling to sweep.
- **Junk signals, v1** (per track): duration < 15 s; bitrate < 48 kbps;
  `size == 0` or missing; unknown mime/grouping; title junk-shaped
  (e.g. `^audio \d+$`-style placeholders).
- **Duplicate signals, v1**: same `(artists-or-null, normalize(title))` group
  where `normalize` = lowercase, strip brackets/feats/punct; plus exact
  `(size, mime)` twins. The keeper suggestion is the largest `size`,
  lossless-preferring row — but the OWNER chooses which survives.

## 4. Review cards (v1) — the bot's entire vocabulary

| Card | Body | Buttons |
| --- | --- | --- |
| Junk | Track title/artist/dur/bitrate/size + why flagged | `Delete` · `Keep` |
| Duplicates | Group listing (`#1 FLAC 30 MB · msgId`, `#2 MP3 8 MB · msgId`) | `Keep #1` · `Keep #2` · `Skip` |
| Result | Post-action receipt: what was deleted via the user session, what survived, errors if any | — |

Card texts are plain text (no Markdown parsing surprises), bounded to sane
lengths, and always carry the `msgId`s that would be deleted. `Skip` keeps
everything and marks the group answered-keep-all. Unknown/lapsed callback taps
(older than `BOT_DECISION_TTL_SECONDS`, default 7 days) are answered once with
"this card expired — the next sweep will re-ask" and the row resets to pending.

## 5. Thin vertical slices (build order)

1. **B0 — end-to-first-path**: bot skeleton (poll loop, owner gate, callback
   router) + automatic sweep at startup + **junk cards with working
   `Delete`/`Keep`** backed by a new user-session `deleteMessages` seam.
   Real deletions, real receipts, end to end.
2. **B1 — duplicate cards**: duplicate detection + `Keep #N` cards; deletion
   of the non-keepers through the same seam.
3. **B2 — durable review memory**: `bot_review` table; sweep skips answered
   findings; pending findings re-ask after restarts; `Skip` semantics.
4. **B3 — hardening**: sweep interval/backoff tuning (`BOT_SWEEP_SECONDS`),
   bot health in the ops payload (only when enabled), soak, selfhost/Render
   doc notes for `BOT_TOKEN`/`BOT_ALLOWED_IDS`.

## 6. Testing stance

- Pure functions first: junk signals, title normalization, grouping, card
  composition, deletion plans (a plan = {chatId, msgIds[]}; nothing here
  touches the network).
- Command routing tested with a scripted bot-client harness (no network) in
  the same spirit as ScriptedLogin: canned updates in → assertions on the
  outputs and on which plan was planned; `deleteMessages` stays an injectable
  seam, tests stay network-free per repo law.

## 7. Environment

```
BOT_TOKEN=               # BotFather token; empty = bot disabled (default)
BOT_ALLOWED_IDS=         # owner's numeric Telegram user id (first = cards chat)
88:BOT_SWEEP_SECONDS=86400  # automatic sweep interval (B3; B5 events sweep sooner)
BOT_DECISION_TTL_SECONDS=604800  # taps older than this expire the card (default 7 d)
```

Additive envs only — every existing behavior is untouched by default.
