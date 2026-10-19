#!/usr/bin/env node
// Interactive Telegram session-string helper (FR-20, §4.8).
// Run ONLY on a trusted machine: it asks for your phone number and the login
// code Telegram sends you. The resulting string is an account credential —
// store it in .env / Docker secrets, never in the repo.
import "dotenv/config";
import readline from "node:readline/promises";
import { exit } from "node:process";
import { stdin, stdout } from "node:process";

const apiId = Number(process.env.TELEGRAM_API_ID ?? "");
const apiHash = process.env.TELEGRAM_API_HASH ?? "";

if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
  console.error("TELEGRAM_API_ID / TELEGRAM_API_HASH missing. Create .env from .env.example first.");
  exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });

try {
  const { TelegramClient, sessions } = await import("telegram");
  const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, {});

  console.error("Logging in. Use a dedicated account with 2FA enabled (§4.8).");
  await client.start({
    phoneNumber: () => rl.question("Phone (international format, +XX…): "),
    phoneCode: () => rl.question("Login code Telegram sent you: "),
    password: () => rl.question("2FA password: "),
    onError: (err) => {
      console.error(`login error: ${err?.message ?? err}`);
      exit(1);
    },
  });

  const session = client.session.save();
  if (typeof session !== "string") throw new Error("session save() did not return a string");
  console.log("\nTELEGRAM_SESSION_STRING (paste into .env, keep secret):");
  console.log(session);
  await client.disconnect();
  rl.close();
} catch (err) {
  rl.close();
  console.error(err?.message ?? err);
  exit(1);
}
