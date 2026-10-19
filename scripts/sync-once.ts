/**
 * Forces one indexer sync pass (and one reconcile sweep) against the live
 * Telegram session from .env, then prints IndexIndexer stats and exits.
 * Useful between boots during M1 bring-up; `npm run sync-once`.
 */
import "dotenv/config";
import { loadConfig } from "../src/config";
import { openDb, createSchema, countTracks, listChatTrackRows, getCursor } from "../src/db";
import { TelegramManager } from "../src/telegram";
import { IndexIndexer } from "../src/index-loop";

const warnings: string[] = [];

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.telegram.configured) {
    console.error("telegram not configured: need TELEGRAM_API_ID/HASH/SESSION_STRING and TARGET_CHANNEL_IDS.");
    process.exitCode = 1;
    return;
  }
  const db = openDb(cfg.dbPath);
  createSchema(db);
  const tm = new TelegramManager(cfg);
  const warn = (m: string) => warnings.push(m);
  const indexer = new IndexIndexer(db, tm, cfg, warn);

  console.log(`connecting (state: ${tm.state})…`);
  await tm.start();
  console.log(`state: ${tm.state} — ${tm.detail ?? ""}`);
  if (tm.state === "fatal") {
    console.error("fatal session; run npm run session to re-provision");
    process.exitCode = 1;
    return;
  }
  if (tm.state !== "ready") {
    console.error("telegram unreachable; check network / session");
    process.exitCode = 1;
    await tm.stop();
    db.close();
    return;
  }

  console.log(`syncing ${cfg.telegram.channels.length} chats…`);
  const t0 = Date.now();
  await indexer.syncOnce();
  console.log(`sync pass done in ${Date.now() - t0}ms`);
  indexer.lastReconcileAt = 0;
  if (cfg.telegram.channels.length) await indexer.reconcileOnce().catch((e) => warnings.push(String(e)));

  console.log(`index: ${countTracks(db)} tracks`);
  for (const chatId of cfg.telegram.channels) {
    console.log(`chat ${chatId}: cursor=${getCursor(db, chatId)} rows=${listChatTrackRows(db, chatId).length}`);
  }
  console.log(`flood cooldown remaining: ${tm.floodCooldownRemaining()}s, waits recorded: ${tm.floodWaits}`);
  if (warnings.length) console.log(`notes:\n${warnings.join("\n")}`);

await indexer.reconcileOnce.bind(indexer);
  await indexer.stop();
  await tm.stop();
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
