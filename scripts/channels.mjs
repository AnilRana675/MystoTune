#!/usr/bin/env node
// Lists the dialogs (channels/groups) the logged-in account can see so the
// ids can be copied into TARGET_CHANNEL_IDS (§4.10).
import "dotenv/config";
import { exit } from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// show currently configured ids for comparison
let configured = [];
if (existsSync(resolve(".env"))) {
  const m = /(?:^|\n)TARGET_CHANNEL_IDS\s*=\s*(.+)/.exec(readFileSync(".env", "utf8"));
  if (m) configured = m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

const apiId = Number(process.env.TELEGRAM_API_ID ?? "");
const apiHash = process.env.TELEGRAM_API_HASH ?? "";
const session = process.env.TELEGRAM_SESSION_STRING ?? "";
if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !session) {
  console.error("Missing TELEGRAM_* env. Run `npm run session` first and paste the string into .env.");
  exit(1);
}

try {
  const { TelegramClient, sessions } = await import("telegram");
  const client = new TelegramClient(new sessions.StringSession(session), apiId, apiHash, {});
  client.setLogLevel("error");
  await client.connect();

  const dialogs = await client.getDialogs({ limit: 1000 });
  console.log(`target channel dialogs of the account (ids usable in TARGET_CHANNEL_IDS):`);
  const suggestable = [];
  for (const d of dialogs) {
    const ent = d.entity;
    if (!ent) continue;
    if (ent.className === "Channel") {
      const full = `-100${ent.id}`; // marked channel id
      suggestable.push([full, ent.title ?? "(untitled)", ent.username ? `@${ent.username}` : "", "channel"]);
    } else if (ent.className === "Chat") {
      const full = `-${ent.id}`; // small group
      suggestable.push([full, ent.title ?? "(untitled)", "", "group"]);
    } else {
      continue; // users are not music sources here
    }
  }
  for (const [full, title, username, kind] of suggestable) {
    const configuredMark = configured.includes(full) ? " [configured]" : "";
    console.log(`${full}  ${title}${username ? "  " + username : ""}  (${kind})${configuredMark}`);
  }
  console.log(`\nconfigured TARGET_CHANNEL_IDS: ${configured.join(", ") || "(none)"}`);
  console.log(`first message sync starts ~5s after boot; run \`npm run sync-once\` to force one now.`);
  await client.disconnect();
} catch (err) {
  console.error(err?.message ?? err);
  exit(1);
}
