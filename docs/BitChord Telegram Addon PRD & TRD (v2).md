# **BitChord Telegram Addon: PRD & TRD (v2.2)**

Revised against the official BitChord addon protocol (bitchord.kushagrasingh.in/docs) · October 19, 2026

v2.1 moves the track index to SQLite on local disk and adds an optional free 30 MB Redis for small caches. Sections 4.11 to 4.13 set the storage rules, the VPS limits and the Node.js settings. Section 4.14 holds the Telegram-specific fixes from the pre-build review (v2.2), and sections 9 to 11 add the setup runbook, repository layout and success metrics.

## **0\. What was wrong in v1, and what changed**

The v1 documents described a generic “streaming add-on”. The BitChord protocol is stricter and different in several places. Built as written, BitChord would reject or ignore the addon.

| \# | v1 said | BitChord protocol says | v2 fix |
| :---- | :---- | :---- | :---- |
| 1 | Routes under /api/... and a manifest endpoint field | Three routes at the addon root: GET /manifest.json, GET /search?q=, GET /stream/{id}. Unknown manifest fields are ignored. | Root-level routes. Drop types and endpoint. |
| 2 | Search returns { "results": \[...\] } with streamUrl per row | Search returns { "tracks": \[...\] }. Rows need non-empty id and title. streamUrl is only an optional fallback. | Use tracks. Add artworkURL, audioQuality. |
| 3 | /stream/:id returns raw audio bytes with Range | /stream/{id} returns **JSON** (url, codec, container, manifest, encrypted, …). BitChord’s player opens the returned url. | Split into a **resolver** (/stream/{id}) and a separate **media proxy** (/media/{token}) that does Range streaming. |
| 4 | No quality handling | BitChord sends quality=lossless|high|low and atmos=auto on search and stream. | Honour or gracefully ignore both; never overstate quality. |
| 5 | No error semantics | 404 \= “not in this addon” (resolution moves on). 429 must include Retry-After. | Defined status-code contract (section 4.4). |
| 6 | Cache “to reduce Telegram calls” | BitChord already caches manifests and searches for 10 min and streams for 5 min. Stream URLs must stay valid at least 5 min. | Signed media URLs with a TTL well above 5 min. Server cache sized accordingly. |
| 7 | Security: “restricted to session strings” | The addon URL is public. Anyone who has it can stream your Telegram library. The session string is a full account credential. | Secret path prefix, signed media URLs, secrets hygiene (section 4.8). |
| 8 | Ignored newer manifest switches | allowDownloads (default 1\) and checkValidLossless (default 0), BitChord 1.7.1+. | Configurable switches (FR-9). |
| 9 | Dolby not mentioned | With atmos=auto, an ordinary track must still play as stereo. | Ignore atmos safely (FR-10). |

## **1\. Overview and objective**

Build a lightweight, self-hosted server that implements the BitChord addon protocol and sources audio from the listener’s own Telegram channels and chats. BitChord never runs addon code. It calls the server over HTTPS, reads JSON, and plays the returned media URL. The server therefore has two jobs: speak the three-route JSON protocol correctly, and serve the actual audio bytes (from Telegram) over a seekable HTTPS endpoint.

### **Goals**

* Pass BitChord’s health check and resolve tracks end to end on Android and desktop.  
* Seekable playback with correct codec and quality metadata, so BitChord’s quality badges are truthful.  
* Run on a 512 MB to 1 GB VPS (stretch target ≤128 MB RAM, planning limit 192 MB, both verified by measurement), with an optional free 30 MB Redis tier.  
* Safe by default: no open access to a private Telegram library.

### **Non-goals**

* Uploading, playlists, user accounts, or multi-tenant hosting.  
* DRM. Encrypted renditions are refused by BitChord anyway (encrypted must be false).  
* Searching Telegram bots or the public Telegram directory (v1 scope is only configured channels and chats).  
* Dolby Atmos or HLS/DASH packaging (Telegram files are plain audio).

## **2\. Users and user stories**

* **Listener.** As a listener, I add my addon URL in Settings → Sources → Add an addon and stream my Telegram music with working seek.  
* **Listener.** As a listener, I want results ranked sensibly and deduplicated, so the right recording plays.  
* **Self-hoster.** As a self-hoster, I deploy with one docker compose up, a .env file, and a TLS reverse proxy.  
* **Self-hoster.** As a self-hoster, I choose whether my addon can be used for downloads and whether it is gated to lossless outputs.  
* **Self-hoster.** As a self-hoster, I can keep strangers out even though the URL must be reachable over HTTPS.

## **3\. Functional requirements**

| ID | Module | Requirement | Priority |
| :---- | :---- | :---- | :---- |
| FR-1 | Manifest | Serve GET /manifest.json with a stable non-empty id, name, version, resources: \["search","stream"\], plus allowDownloads and checkValidLossless. | P0 |
| FR-2 | Telegram connector | Maintain an MTProto connection using API ID/hash and a pre-generated session string (no interactive login on startup). Auto-reconnect. Verify membership of each target chat on boot. | P0 |
| FR-3 | Search | GET /search?q= returns { "tracks": \[...\] } from the configured chats. Each row has id, title, plus artist, album, duration (seconds), format, audioQuality where known. | P0 |
| FR-4 | Stream resolver | GET /stream/{id} returns JSON with an absolute HTTPS url, accurate codec, container, manifest: "none", encrypted: false. 404 when the track is not found. | P0 |
| FR-5 | Media proxy | GET/HEAD /media/{token} streams the Telegram file with Range support (200/206/416), no full-file disk writes, and aborts the Telegram download when the client disconnects. | P0 |
| FR-6 | Truthful quality | Derive codec, container, and audioQuality from the real file. Never label a lossy file as lossless. Accept quality and respond with the best available rendition (Telegram has one). | P0 |
| FR-7 | Access control | Secret path prefix on the addon root, HMAC-signed expiring media URLs, constant-time comparison, no secrets in logs. | P0 |
| FR-8 | Cache | Track index in SQLite (FTS5) on local disk, not in RAM. Small caches (resolved messages, recent searches) with hard entry caps and TTLs, held in process or in optional Redis (section 4.11). | P1 |
| FR-9 | Manifest switches | ALLOW\_DOWNLOADS and CHECK\_VALID\_LOSSLESS env vars map to manifest allowDownloads / checkValidLossless. | P1 |
| FR-10 | Atmos handling | Accept and ignore atmos=auto. Always return stereo rather than an error. | P1 |
| FR-11 | Observability | /healthz (internal), structured logs, basic counters (searches, streams, bytes, FloodWaits). | P1 |
| FR-12 | Artwork | Serve Telegram audio thumbnails via /art/{token} and return absolute artworkURL. | P2 |
| FR-13 | Deep probing | Read the first bytes of FLAC (STREAMINFO) for duration and sampleRate/bitDepth, and of MP3 for ID3 album tags. Required for FLAC sent as plain documents, which carry no duration attribute. | P1 |
| FR-14 | Sync | Poll each target chat every SYNC\_INTERVAL\_MINUTES using a stored last-message cursor (min\_id) instead of a live-update subscription. The first run pages slowly and resumes after a restart. | P0 |
| FR-15 | Optional Redis | If REDIS\_URL is set, use it for cooldowns, rate limits and small caches. Every call has a 200 ms timeout and falls back to in-process state, so Redis never blocks playback. | P2 |
| FR-16 | Resource limits | Enforce stream, chunk and cache caps so RSS stays within the 192 MB limit and near the 128 MB stretch target (section 4.12). Expose RSS and cache sizes on /healthz. | P0 |
| FR-17 | Query handling | Sanitize free text before FTS5 so characters like \- " : \* never cause errors. Prefix-match tokens, AND first with an OR fallback. Parse quality case-insensitively. Clean junk from titles before matching (section 4.14). | P0 |
| FR-18 | Readiness | /manifest.json and /search answer 200 while the index is building and when Telegram is unreachable. Only /stream and /media for a known track return 503 on a Telegram outage. | P0 |
| FR-19 | Stream admission | Queue up to 2 s instead of rejecting. Count only requests actively streaming bytes. A new Range request for the same token replaces that token’s previous one. | P0 |
| FR-20 | Session safety | One running instance per session string. On AUTH\_KEY\_DUPLICATED or AUTH\_KEY\_UNREGISTERED, log once, stop retrying, report unhealthy and exit. | P0 |

## **4\. Technical requirements**

### **4.1 Stack**

* **Default:** Node.js (current LTS) \+ Fastify \+ GramJS (telegram package). Its iterDownload supports offset, limit, and requestSize, which maps directly onto HTTP Range.  
* **Alternative:** Python 3.11 \+ FastAPI \+ Telethon (or Pyrogram). Choose this if benchmarks show lower RSS.  
* Docker (multi-stage, non-root, read-only root filesystem) and Docker Compose. TLS is terminated by a reverse proxy (Caddy, Nginx, or a Cloudflare Tunnel). BitChord requires HTTPS.

**Risk:** a Node runtime plus an MTProto client may idle near or above 100 MB. Expect 150 to 200 MB under load (estimate): the 72 MB heap cap does not cover Buffers, native code, sockets or the SQLite cache. Treat 128 MB as a stretch target and 192 MB as the planning limit, both verified in the M0 soak (section 7). Start with \--max-old-space-size=72, and benchmark the Python alternative if the target is missed.

### **4.2 Architecture**

BitChord app ──HTTPS──\> Reverse proxy (TLS) ──\> Addon server ──MTProto──\> Telegram  
   1\. GET /\<secret\>/manifest.json            (JSON)  
   2\. GET /\<secret\>/search?q=...              (JSON { tracks })  
   3\. GET /\<secret\>/stream/{id}?quality=...   (JSON { url, codec, ... })  
   4\. GET \<url from step 3\>  /media/{token}   (audio bytes, Range)  
Steps 1 to 3 are the protocol. Step 4 is not part of the protocol. It is an ordinary HTTPS URL that BitChord’s player opens, and it is where Range and seeking live.

The listener adds https\://your-domain.com/\<ADDON\_SECRET\> (root) or its /manifest.json. BitChord normalizes and stores the root, so the secret prefix travels with every request.

### **4.3 Endpoint specification**

All JSON responses carry Cache-Control: no-store and Content-Type: application/json.

**GET /manifest.json**

{  
  "id": "dev.yourname.telegram-addon",  
  "name": "Telegram Library",  
  "version": "2.0.0",  
  "description": "Streams music from your own Telegram channels",  
  "resources": \["search", "stream"\],  
  "allowDownloads": 1,  
  "checkValidLossless": 0  
}  
The id must be stable across restarts and upgrades. An empty id is rejected. Optional settings (for example a quality select) are forwarded as query defaults. BitChord renders no settings UI, so omit it unless needed.

**GET /search?q={query}\&quality={tier}\&atmos=auto**

{  
  "tracks": \[  
    {  
      "id": "tg\_n1001234567890\_789",  
      "title": "Song Title",  
      "artist": "Artist Name",  
      "album": "Album Name",  
      "duration": 210,  
      "format": "flac",  
      "audioQuality": "LOSSLESS"  
    }  
  \]  
}

* id is opaque and stable: tg\_{peerKey}\_{messageId} (peer key: the signed chat id with the minus sign written as n, for example n1001234567890, so a user and a channel never collide). It is safely URL-encoded by BitChord.  
* duration is in seconds. artworkURL (absolute) only if FR-12 is implemented.  
* Return the best matches first (BitChord keeps your order while it checks recording matches). Cap at 25 rows. There is no limit parameter.  
* Empty or no matches: { "tracks": \[\] } with status 200\.

**GET /stream/{id}?quality={tier}\&atmos=auto**

{  
  "url": "https\://your-domain.com/media/eyJpZCI6...\<sig\>",  
  "format": "flac",  
  "quality": "Lossless · FLAC",  
  "codec": "flac",  
  "container": "flac",  
  "manifest": "none",  
  "encrypted": false  
}

* url must be absolute and directly playable. A relative URL is rejected before playback.  
* sampleRate, bitDepth, bitrate are optional. Include them only when known (FR-13 or a computed bitrate), never guessed.  
* Unknown id or deleted message: 404 with no body.

**GET|HEAD /media/{token}** (not part of the protocol)

* The token is base64url(payload).base64url(hmac), where payload \= { id, exp } and the HMAC uses MEDIA\_SIGNING\_KEY. Default TTL is 6 h (MEDIA\_URL\_TTL\_SECONDS), well above BitChord’s 5-minute stream cache.  
* No Range header: 200, full Content-Length. With Range: bytes=X-Y or bytes=X-: 206 with Content-Range: bytes X-Y/TOTAL, Content-Length of the slice. Out-of-bounds: 416 with Content-Range: bytes \*/TOTAL.  
* Always send Accept-Ranges: bytes, Content-Type (see 4.5), Cache-Control: private, max-age=300. HEAD returns the headers without a body.  
* Expired or invalid token: 403. Never reveal which check failed.

### **4.4 Status-code contract**

| Situation | Response |
| :---- | :---- |
| Track not in this addon / message deleted | 404, empty body (BitChord moves to the next source) |
| Telegram FLOOD\_WAIT\_X | 429 with Retry-After: X |
| Telegram temporarily unreachable | 503 with Retry-After |
| Bad or missing q | 200 with { "tracks": \[\] } |
| Bad/expired media token | 403 |
| Unsatisfiable Range | 416 |

Return 404 only for a true miss. Using it for transient errors makes BitChord silently fall back to another source.

### **4.5 Format and quality mapping**

Telegram stores one file per message, so there is one rendition. The server reports it honestly rather than inventing a tier.

| Telegram MIME | codec | container | Lossless? |
| :---- | :---- | :---- | :---- |
| audio/mpeg | mp3 | mp3 | No |
| audio/flac, audio/x-flac | flac | flac | Yes |
| audio/wav, audio/x-wav | pcm | wav | Yes |
| audio/mp4, audio/x-m4a, audio/aac | aac | mp4 / aac | No (see note) |
| audio/ogg, audio/opus | opus | ogg | No |

Note: an .m4a file may actually contain ALAC. Without probing, report aac conservatively. FR-13 can detect ALAC.

For audio/ogg, the codec can be Vorbis or Opus. When a file cannot be identified without a probe, omit codec and send only container rather than guessing. BitChord reads declared codec metadata before guessing from the URL, so a wrong declaration is worse than none.

audioQuality in search rows is derived as follows:

* LOSSLESS for FLAC/WAV/ALAC.  
* For lossy codecs, estimate bitrate as size × 8 / duration: HIGH at ≥ 224 kbps, otherwise LOW.

Quality negotiation: BitChord verifies quality against the codec it actually decodes. A “lossless” label on a lossy file produces no lossless badge, so never fake it. quality=lossless with only an MP3 available still returns the MP3 with codec: "mp3" (do not return 404, since playing something beats falling back).

### **4.6 Indexing and search**

1. **Source filter.** Only messages with MessageMediaDocument whose MIME starts with audio/. Skip voice notes (DocumentAttributeAudio.voice \= true). Keep files with no duration and omit duration from the row, or read it from the file header (FLAC STREAMINFO, FR-13).  
2. **Metadata priority.** (a) DocumentAttributeAudio title and performer; (b) caption or filename parsed as Artist \- Title; (c) optional ID3 read of the first 64 KB for MP3 (FR-13). Telegram has no sample-rate or album field, so album is often missing. This is acceptable because album is only “recommended”.  
3. **Index.** On boot, page through each target chat with messages.search using InputMessagesFilterMusic, plus a document scan (InputMessagesFilterDocument) filtered to audio/\* MIME types or audio file extensions, because FLAC is often sent as a plain document, storing in SQLite only { id, chatId, msgId, title, artist, album, duration, mime, size, fileName }. Do not subscribe to live updates: poll for newer messages every SYNC\_INTERVAL\_MINUTES (default 10), using the stored cursor as min\_id. Reconcile deletions every RECONCILE\_INTERVAL\_HOURS (default 24\) by checking known message ids in batches of 100 at a slow rate, instead of re-paging each chat. A deleted message also returns 404 at stream time.  
4. **Query.** Normalize (lowercase, strip diacritics and punctuation). Match tokens over title, artist, album and filename with SQLite FTS5, ranked by bm25. Boost exact title and artist matches. Deduplicate near-identical tracks across chats (same normalized title and artist, duration within ±2 s) and keep the better one (lossless first, then the larger file).  
5. **Bound memory.** Cap the index at MAX\_INDEX\_ENTRIES (default 50,000, about 15 to 25 MB on disk, near zero RAM). If more are found, keep the newest and log a warning.

### **4.7 Streaming pipeline**

1. Validate token, then look up the entry, then re-fetch the message via getMessages (document file references expire, so never persist them).  
2. Parse the Range header and compute \[start, end\] against size.  
3. Telegram upload.getFile requires offsets and limits that are multiples of 4 KiB, and a single request must not cross a 1 MiB boundary. Align the first request down to a 512 KiB boundary (512 KiB divides 1 MiB, so no request crosses it), stream chunks, and trim the head and tail bytes to match the requested range exactly.  
4. Pipe chunks to the HTTP response with backpressure (await drain). Cap in-flight buffering at one 512 KiB chunk plus one chunk of read-ahead per stream.  
5. On client disconnect, abort the iterator immediately. Seeks in a player cause many short-lived requests, so leaks here are the likeliest cause of memory growth.  
6. Warm path: keep the connection to the file’s DC alive. A cold DC connection adds an auth-export round trip and is the main threat to the first-byte target.  
7. Concurrency: global cap MAX\_CONCURRENT\_STREAMS (default 2 on a VPS of 1 GB or less, 4 otherwise). Count only requests that are actively streaming bytes. Excess requests wait in a queue for up to 2 s (section 4.14), then get 503 with Retry-After: 2.

### **4.8 Security and compliance**

* **Session string \= account password.** Store only in env or a Docker secret. Never log it. Use a dedicated Telegram account that is a member of the target chats if possible. Enable Telegram 2-step verification.  
* **Secret path prefix.** All routes live under /{ADDON\_SECRET}/. Use at least 32 random characters. Redact it in access logs (BitChord’s own checklist calls out path-based tokens in logs).  
* **Signed media URLs** (HMAC-SHA256, constant-time compare, expiry). The /media route needs no prefix since the signature is the credential.  
* **Rate limiting** per IP on /search and /stream to avoid triggering Telegram FloodWait.  
* **Scope of use.** For the operator’s own library or content they have the right to access. Respect Telegram’s API terms (do not hammer the API; use FloodWait back-off). Decide allowDownloads deliberately (below).  
* Container runs as non-root, read-only filesystem, no inbound ports except the proxy’s.

### **4.9 Manifest switches**

| Env var | Manifest key | Default | Notes |
| :---- | :---- | :---- | :---- |
| ALLOW\_DOWNLOADS | allowDownloads | 1 | 0 means playback only, and BitChord asks the next source for downloads. It is a policy, not DRM. Honoured by Android and desktop. |
| CHECK\_VALID\_LOSSLESS | checkValidLossless | 0 | 1 means BitChord (Android only) contacts the addon only on wired, USB, HDMI, LDAC, LHDC, or aptX Lossless outputs. Leave 0 for a mixed MP3/FLAC library. |

Both keys need BitChord 1.7.1+. Older versions ignore them safely. Changes propagate on the next manifest read (cached up to 10 minutes).

### **4.10 Configuration (.env)**

PORT=8080  
PUBLIC\_BASE\_URL=https\://your-domain.com  
ADDON\_SECRET=\<32+ random chars\>  
MEDIA\_SIGNING\_KEY=\<32+ random bytes, base64\>  
MEDIA\_URL\_TTL\_SECONDS=21600  
TELEGRAM\_API\_ID=12345678  
TELEGRAM\_API\_HASH=\<hash\>  
TELEGRAM\_SESSION\_STRING=\<string session\>  
TARGET\_CHANNEL\_IDS=-100123456789,-100987654321  
MAX\_INDEX\_ENTRIES=50000  
RECONCILE\_INTERVAL\_HOURS=24  
MAX\_CONCURRENT\_STREAMS=2  
ALLOW\_DOWNLOADS=1  
CHECK\_VALID\_LOSSLESS=0  
LOG\_LEVEL=warn  
The session string is generated once with a local helper script (npm run session) that performs the interactive OTP login. The server never prompts.

### **4.11 Storage layer: SQLite for the index, optional Redis for small caches**

The track index lives in SQLite on local disk. A free 30 MB Redis holds only small, expendable state, and the addon runs without it. On a single instance, in-process maps and an LRU do the same job, so leave Redis off unless the host has an ephemeral disk (for the snapshot) or you run more than one instance.

Why the index stays out of Redis:

* **Latency.** Local SQLite reads take about 1 ms. A hosted free Redis adds roughly 20 to 100 ms per call, and a search needs several lookups, which breaks the 300 ms search target.  
* **Search.** SQLite FTS5 gives full-text matching with bm25 ranking. Redis has no full-text search without the RediSearch module, which free plans may not include.  
* **Size.** A 50k-track index needs roughly 20 to 25 MB in Redis (estimate, measure it), which fills most of a 30 MB cap and leaves no room for anything else.  
* **Restarts.** A disk index survives restarts, so the addon does not re-index and trigger FloodWait on every boot.

What Redis holds:

| Key | Holds | TTL | Approx. size |
| :---- | :---- | :---- | :---- |
| flood:until | Shared FloodWait cooldown (epoch seconds) | Equals the wait | Bytes |
| rl:{ip}:{minute} | Rate-limit counter | 60 s | Bytes |
| msg:{id} | Size, MIME type and DC id of a resolved track | 30 min | About 200 B |
| q:{hash} | Track ids for a recent search | 10 min | About 1 KB, max 500 entries |
| index:snapshot | Compressed index snapshot (ephemeral-disk hosts only) | None | A few MB, measure it |

Rules:

1. Open one or two Redis connections (free plans cap connections), use TLS, and set a 200 ms command timeout. Pick the Redis region closest to the VPS, because a distant one can exceed the timeout on every call.  
2. Give every key a TTL except the snapshot, and cap q: entries at 500 so the cache cannot grow toward the limit.  
3. If Redis is down or slow, fall back to a small in-process LRU and local counters. Never block playback on Redis.  
4. Never store the session string, the signing key or audio bytes in Redis.  
5. The sync cursor (last indexed message id per chat) is stored in SQLite. Redis is never its only copy.  
6. Check that the plan persists data across restarts before relying on the snapshot. Treat all other keys as disposable.

**Ephemeral-disk hosts.** If the host wipes the filesystem on redeploy (some free tiers do), set REDIS\_SNAPSHOT=1. After each sync, write a gzip-compressed snapshot of the index to index:snapshot. On boot, restore it, then sync only messages newer than the cursor. With a persistent disk, mount ./data and skip the snapshot.

Add these to the .env from section 4.10:

DB\_PATH=/data/index.sqlite  
SYNC\_INTERVAL\_MINUTES=10  
REDIS\_URL=  
REDIS\_TIMEOUT\_MS=200  
REDIS\_SNAPSHOT=0  
ADMISSION\_WAIT\_MS=2000  
MAX\_CONCURRENT\_STREAMS=2  
Leave REDIS\_URL empty to run without Redis. MAX\_CONCURRENT\_STREAMS=2 matches the 4.10 default for small hosts. Raise it only on a host with 2 GB or more.

### **4.12 Low-resource profile (512 MB to 1 GB VPS)**

On a small VPS, memory leaks from long-lived streams and bandwidth are the main risks, so these settings override the defaults in 4.7.

* **Telegram client.** One connection only, log level error, no live-update subscription (polling replaces it, see FR-14). Update loops are a known source of idle memory growth in GramJS and Telethon.  
* **Chunks.** Request 512 KiB chunks, aligned so none crosses a 1 MiB boundary. Allow one chunk of read-ahead per stream, respect backpressure, and abort the Telegram download as soon as the client disconnects.  
* **Concurrency.** MAX\_CONCURRENT\_STREAMS=2. Extra requests queue for up to 2 s (section 4.14), then get 503 with Retry-After: 2.  
* **Node runtime.** NODE\_OPTIONS="--max-old-space-size=72 \--max-semi-space-size=2", Fastify, no heavy middleware.  
* **Python runtime.** One worker only, with uvloop. Several workers would each open their own Telegram client.  
* **Fallback runtime.** If the M0 benchmark misses the target, Go (gotd/td) or Rust (grammers) typically idle at 20 to 40 MB (approximate). Rewrite only if measurement forces it.  
* **No CPU-heavy work.** No transcoding. FR-13 probing stays opt-in. Compress JSON at the reverse proxy, never audio.  
* **Bandwidth.** Every track crosses the VPS twice (Telegram to VPS, VPS to phone), so a 40 MB FLAC costs 80 MB of transfer. Check the provider’s monthly cap. Send ETag and Accept-Ranges, and honour If-Range, so seeks and reconnects do not re-download.  
* **Region.** Pick the VPS region near the Telegram DC that stores your files (document.dcId). A long hop to that DC dominates first-byte latency. Verify by measurement.  
* **Host safety net.** 512 MB of swap or zram, a Caddy reverse proxy for TLS, and a container memory limit below the VPS total so an out-of-memory kill hits the addon, not the host.

services:  
  addon:  
    restart: unless-stopped  
    mem\_limit: 192m        \# planning limit; tighten toward 128m only if the M0 soak allows  
    memswap\_limit: 384m  
    init: true  
    read\_only: true  
    tmpfs: \["/tmp"\]  
    environment:  
      NODE\_OPTIONS: "--max-old-space-size=72 \--max-semi-space-size=2 \--optimize-for-size"  
      LOG\_LEVEL: warn  
    healthcheck:  
      test: \["CMD", "node", "-e", "fetch('http\://127.0.0.1:8080/healthz').then(r=\>process.exit(r.ok?0:1)).catch(()=\>process.exit(1))"\]  
      interval: 30s  
      timeout: 5s  
      retries: 3  
    logging:  
      driver: json-file  
      options: { max-size: "5m", max-file: "2" }  
    volumes: \["./data:/data"\]  
**Verification.** /healthz reports RSS, index size and cache sizes. Run a 30-minute soak with 2 streams and random seeks. If RSS climbs steadily, look for a leaked iterator or an unbounded cache. Also stop Redis during the soak and confirm search and playback keep working.

### **4.13 Node.js optimization**

Node.js with GramJS is the runtime. Bun is excluded for now: GramJS’s long-lived socket client is untested on it here, and Bun’s JavaScriptCore engine has no hard heap cap like V8’s. Revisit only if the M0 soak shows Node cannot meet the 128 MB target.

| Setting | Value | Why |
| :---- | :---- | :---- |
| Process model | One process, current Node LTS | No cluster or worker\_threads: each extra process adds a Telegram client and a heap |
| NODE\_OPTIONS | \--max-old-space-size=72 \--max-semi-space-size=2 \--optimize-for-size | Caps the V8 heap and trades a little CPU for memory |
| UV\_THREADPOOL\_SIZE | 2 | Fewer libuv worker threads |
| MALLOC\_ARENA\_MAX | 2 (glibc images) | Limits per-thread allocator arenas that inflate RSS |
| Chunk size | Fixed 512 KiB | Buffers are off-heap, so the heap cap does not bound them |
| GramJS log level | error | Default logging is verbose |
| floodSleepThreshold | 0 | Throws FloodWait at once, so the addon returns 429 with Retry-After instead of holding the request while the library sleeps |
| SQLite (better-sqlite3) | WAL, synchronous=NORMAL, cache\_size=-8000, statements prepared once | About 8 MB page cache |
| Logging | pino, async destination, level warn | No pretty-printing in production |
| Dependencies | Fastify only, npm ci \--omit=dev | No axios, lodash or other large helpers |

const client \= new TelegramClient(new StringSession(SESSION), API\_ID, API\_HASH, {  
  connectionRetries: 5,  
  floodSleepThreshold: 0,  
});  
client.setLogLevel("error");  
Code rules:

1. **Streaming.** Use stream.pipeline with an AbortController. Abort the Telegram iterator on the response’s close event, wait for drain, avoid Buffer.concat, and drop chunk references after each write.  
2. **Range maths.** In M2, verify the offset and limit semantics of iterDownload (bytes or chunks) against the installed GramJS version, then cover them with the checksum test from section 5\.  
3. **Memory watch.** /healthz reports rss, heapUsed, external, arrayBuffers and active stream count. Rising external with a flat heap means a leaked Buffer or iterator. Start the server with \--heapsnapshot-signal=SIGUSR2 to capture a heap snapshot on demand.  
4. **Base image.** In M0, benchmark node:\*-alpine against node:\*-slim and keep the one with the lower RSS. musl’s allocator can fragment under buffer churn.  
5. **Optional Bun check.** Time-box it to one hour. Run the 30-minute soak (2 streams, random seeks, a forced network drop) on both runtimes. Switch only if Bun’s RSS is clearly lower (for example by 25 MB or more) and reconnects survive. Keep the database behind a thin interface (better-sqlite3 on Node, bun:sqlite on Bun) so the check stays cheap.

### **4.14 Telegram-specific hardening**

These rules come from the pre-build review. Each one targets a failure that is likely when Telegram, SQLite and the BitChord player meet.

**Session safety (FR-20)**

* Generate the session string with the helper script for this server only. Never copy it to a second machine, a dev laptop or a second container.  
* If Telegram returns AUTH\_KEY\_DUPLICATED or AUTH\_KEY\_UNREGISTERED, log once, stop reconnecting, mark /healthz unhealthy and exit. A retry loop makes it worse.

**Documents and file references**

* Keep an in-process LRU of resolved documents (200 entries, 10 min TTL), so a seek costs no Telegram lookup.  
* On FILE\_REFERENCE\_EXPIRED, re-fetch the message once and retry once. Never store file references in SQLite or Redis.  
* Send ETag: "{documentId}-{size}" and honour If-Range.

**Query handling (FR-17)**

Free text must never reach FTS5 raw: \-, ", : and \* are query syntax and cause errors. Use a builder like this (folds accents, drops punctuation, caps at 8 tokens, prefix-matches):

function ftsQuery(raw) {  
  const tokens \= raw  
    .normalize("NFKD").replace(/\[\\u0300-\\u036f\]/g, "")  
    .toLowerCase()  
    .replace(/\[^\\p{L}\\p{N}\\s\]/gu, " ")  
    .split(/\\s+/).filter(Boolean).slice(0, 8);  
  if (\!tokens.length) return null;  
  const q \= tokens.map((t) \=\> '"' \+ t \+ '"\*');  
  return { and: q.join(" AND "), or: q.join(" OR ") };  
}  
Run the AND query first. If it returns fewer than 5 rows, run the OR query. Rank by bm25 with a boost for exact title and artist matches. Parse quality case-insensitively, because the BitChord docs show both lossless and LOSSLESS.

**Title cleaning**

BitChord matches on title, artist and duration, and Telegram filenames are noisy. Before indexing:

* Strip the extension, turn underscores into spaces, and drop leading track numbers (01 \-, 1\.).  
* Remove bitrate and format tags (\[320kbps\], (FLAC)), @channel handles and t.me/... links.  
* Split Artist \- Title on the first \-.  
* Keep live, remix, edit and instrumental markers, because BitChord uses them to avoid the wrong recording.  
* Keep the original filename as an extra FTS column, so a dirty name can still be found.

**Readiness (FR-18)**

* /manifest.json must not depend on Telegram.  
* /search serves whatever SQLite holds, even mid-index. An empty index returns { "tracks": \[\] }, never 503\. /healthz carries the indexing flag.  
* /stream/{id} returns 404 for unknown ids, and 503 with Retry-After only when Telegram is unreachable for a known track.

**Stream admission (FR-19)**

Players preload the next track, probe with short ranges and reopen connections on seek, and a Download holds a connection for the whole file.

* Count only requests that are actively streaming bytes. HEAD requests and range probes of 4 KiB or less are free.  
* Extra requests wait up to ADMISSION\_WAIT\_MS (default 2000), then get 503 with Retry-After: 2.  
* A new Range request for the same token aborts that token’s previous request, so a seek storm never stacks up.

**Telegram limits to verify in M2**

* Free accounts may get slower downloads. Real-time FLAC needs roughly 0.1 to 0.4 MB/s (estimate), so playback should be fine, but measure first-byte time on a 50 MB+ file.  
* Channels with protected content may refuse downloads. If getFile is refused, skip that channel and log it. This is untested.

**Hosting**

* The BitChord docs do not explicitly say a root URL with a secret path prefix (/\<ADDON\_SECRET\>) is accepted, though their checklist mentions path-based tokens. Test it in M0. If BitChord drops the prefix, fall back to a long random subdomain and rely on signed media URLs, so a leaked search URL exposes metadata only.  
* Cloudflare’s proxy or tunnel may restrict large media traffic under its terms. Check them, or run Caddy directly on the VPS.

## **5\. Non-functional requirements**

| Area | Target | How verified |
| :---- | :---- | :---- |
| Resolve latency | /stream/{id} p95 \< 150 ms (index hit) | Load test |
| Start of playback | First audio byte from /media p95 \< 600 ms on a warm DC connection | Timed Range request |
| Search latency | p95 \< 300 ms for a 50k-track index | Load test |
| Memory | RSS ≤ 128 MB (stretch) and ≤ 192 MB (hard limit) with 2 concurrent streams and a 50k-track SQLite index | docker stats over a 30-minute soak |
| Seek correctness | Byte-exact slices for random ranges vs the source file | Checksum test |
| Reliability | Auto-reconnect to Telegram within 30 s of a drop | Fault injection |
| URL lifetime | Media URLs valid ≥ 5 min (BitChord stream cache) | Contract test |

The v1 target of “\< 600 ms startup” was ambiguous. It now refers to first byte of audio, and the resolver is budgeted separately.

## **6\. Delivery plan**

| Milestone | Scope | Exit criteria |
| :---- | :---- | :---- |
| M0: Contract stub | Manifest, /search, /stream with fixture data; HTTPS tunnel | BitChord accepts the URL, health check passes, a fixture track plays, baseline RSS and soak numbers recorded |
| M1: Telegram read | Session login, SQLite index with sync cursor, FLAC header probe, real search, metadata mapping | Real tracks listed with correct title, artist, duration |
| M2: Media proxy | Signed URLs, Range streaming, abort handling | Seek works on MP3 and FLAC; checksum test passes |
| M3: Hardening | Access control, rate limits, FloodWait mapping, optional Redis caches, Docker, memory soak | All NFRs met; checklist in section 7 complete |
| M4: Extras | Artwork, ID3 probing, ALAC detection | Optional |

## **7\. Acceptance tests and production checklist**

Contract checks (BitChord’s own recommended probes):

curl \-s https\://your-domain.com/\$SECRET/manifest.json  
curl \-s "https\://your-domain.com/\$SECRET/search?q=test\&quality=LOSSLESS"  
curl \-s "https\://your-domain.com/\$SECRET/stream/\<encoded-id\>?quality=LOSSLESS"  
curl \-s \-r 1000000-1000999 \-o /tmp/slice "\<url from stream\>" \-D \-  
Expect: a manifest with non-empty id; tracks rows each with id and title; a stream url that is absolute HTTPS; and a 206 with the correct Content-Range for the slice.

Checklist adapted from the BitChord production list:

* ☐ Addon id and track ids are stable across restarts  
* ☐ HTTPS on every returned URL (media and artwork)  
* ☐ JSON content type on all success responses  
* ☐ Search answers quickly; empty results return tracks: \[\]  
* ☐ Stream URLs survive at least 5 minutes (default 6 h)  
* ☐ 404 for a missing track; 429 includes Retry-After  
* ☐ encrypted is false on every rendition  
* ☐ codec, container, manifest are accurate; lossy files never labelled lossless  
* ☐ Logs never contain the addon secret, signed tokens, or the session string  
* ☐ Stereo fallback with atmos=auto  
* ☐ Duration metadata present on all rows (improves recording matching)  
* ☐ allowDownloads set deliberately; checkValidLossless only if intended  
* ☐ Memory soak test passes within 192 MB (stretch: 128 MB)  
* ☐ Searches with \-, quotes, colons, emoji and 10-word queries return 200, never an error  
* ☐ A FLAC sent as a plain document appears in search and plays  
* ☐ A seek storm during an active Download produces no 503 and no FloodWait  
* ☐ The session string is used by one instance only, and AUTH\_KEY\_DUPLICATED is logged once without a retry loop  
* ☐ With Redis stopped, search and playback keep working  
* ☐ Manifest and search return 200 while the index is building and while Telegram is unreachable

## **8\. Risks and open questions**

| Risk / question | Impact | Mitigation / decision needed |
| :---- | :---- | :---- |
| GramJS plus Node idles above 128 MB | Misses footprint goal | Benchmark early (M0). Fall back to Python/Telethon or keep the 192 MB planning limit. |
| Telegram FloodWait during indexing of large channels | Slow first index, 429s | Page slowly, persist progress, expose index status in /healthz. |
| Poor or missing tags (no album, messy filenames) | Wrong recording matched by BitChord | Filename parsing, optional ID3 probe, document tagging convention for users. |
| Session string theft | Full Telegram account takeover | Dedicated account, 2FA, Docker secrets, no logging. |
| Public addon URL leaks | Strangers stream your library | Secret prefix plus rate limit; rotate ADDON\_SECRET (requires re-adding the addon in BitChord). |
| Copyright exposure | Legal risk for the operator | Personal-use positioning. Consider ALLOW\_DOWNLOADS=0 as the default for shared deployments. |
| Decided: Node.js, not Bun or Python | Affects the whole build | Node.js with GramJS is the runtime (section 4.13). Python stays the fallback only if the M0 soak misses the memory target. |
| Open: single user or shared instance? | Changes the access model | v2 assumes single-operator. Multi-user needs per-user tokens (post-v2). |
| Free Redis tier (30 MB) fills, evicts data, or is unreachable | Lost caches, slower search, weaker rate limiting | Redis holds only expendable state with TTLs and a 500-entry search-cache cap. 200 ms timeouts and in-process fallback keep playback working. |
| Host has an ephemeral filesystem | SQLite index is wiped on redeploy and re-indexing triggers FloodWait | Mount a volume. If that is impossible, set REDIS\_SNAPSHOT=1 to restore a compressed index snapshot, then sync from the cursor. |
| Monthly bandwidth cap on the VPS | Every track is transferred twice (Telegram to VPS, VPS to phone) | Check the provider’s transfer limit. Honour If-Range and ETag so seeks and reconnects do not re-download. |
| Session string used from two places | Telegram invalidates it (AUTH\_KEY\_DUPLICATED) and the addon goes dark | Dedicated session, one instance, FR-20. |
| Audio sent as plain documents (often FLAC) | Tracks missing from search or without duration | Document scan plus FLAC header probe (section 4.6, FR-13). |
| Free-account download throttling or protected-content channels | Slow first byte or refused downloads | Measure in M2 with a 50 MB+ FLAC. Skip and log channels that refuse downloads. |
| Proxy or tunnel terms for media traffic | Hosting suspended or throttled | Check Cloudflare’s terms for audio traffic, or run Caddy directly on the VPS. |

## **9\. Setup runbook**

1. **API credentials.** Log in at my.telegram.org with the dedicated account, open API development tools, create an app, and copy api\_id and api\_hash.  
2. **Join the channels** with that account (private channels need an invite link).  
3. **Find channel ids** with a helper script (npm run channels, written in M1) that lists dialogs with their ids. Channel ids look like \-100123456789.  
4. **Generate the session** once with npm run session on a trusted machine. Store the string as a secret and never reuse it elsewhere.  
5. **Create .env** from sections 4.10 and 4.11. Generate secrets with openssl rand \-hex 24 (ADDON\_SECRET) and openssl rand \-base64 32 (MEDIA\_SIGNING\_KEY).  
6. **Deploy.** Run docker compose up \-d, point the reverse proxy at port 8080, then check curl https\://your-domain.com/\$ADDON\_SECRET/manifest.json.  
7. **Wait for the first index.** /healthz shows the indexed count and the indexing flag.  
8. **Add to BitChord.** Settings → Sources → Add an addon, paste https\://your-domain.com/\<ADDON\_SECRET\>, run the health check, then play one MP3 and one FLAC, seek in both, and test a Download if enabled.  
9. **Rotate.** To change ADDON\_SECRET, restart with the new value and re-add the addon in BitChord.

## **10\. Repository layout and tests**

src/  
  server.ts     Fastify routes: manifest, search, stream, media, healthz  
  telegram.ts   GramJS client, session guard, document LRU  
  indexer.ts    sync loop, reconcile, title cleaning  
  db.ts         SQLite schema, FTS5, queries  
  media.ts      Range parsing, chunk pipeline, admission control  
  sign.ts       HMAC tokens  
  config.ts     env parsing  
Dockerfile, compose.yaml, .env.example  
test/           contract, range, query, admission, fault

| Test | What it proves |
| :---- | :---- |
| Contract | Manifest, search and stream match the BitChord shapes (non-empty id, tracks, absolute url, 404 and 429 behaviour) |
| Range | 50 random slices of an MP3 and a FLAC match the source bytes, including 200, 206 and 416 |
| Query | Hostile strings (\-, quotes, colons, emoji, 10-word queries) return 200 and never an FTS error |
| Admission | A seek storm during an active Download produces no 503 and no FloodWait |
| Fault | Telegram drop, Redis down and AUTH\_KEY\_DUPLICATED behave as specified in FR-18 and FR-20 |

## **11\. Success metrics**

* At least 95% of 50 sampled searches from your own library resolve and start playing.  
* First audio byte p95 under 600 ms on a warm DC connection.  
* All 50 random seeks return correct bytes.  
* Zero 5xx responses during a 30-minute soak with 2 players.  
* A new track becomes searchable within SYNC\_INTERVAL\_MINUTES plus one minute.  
* RSS stays within the 192 MB limit, and near 128 MB if the stretch target holds.