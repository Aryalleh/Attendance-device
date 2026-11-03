// Set (or create) a panel user's password in D1.
//   node scripts/set-password.mjs admin           -> production database
//   node scripts/set-password.mjs admin --local   -> local `wrangler dev` database
// Uses the same PBKDF2 format as src/auth.ts.
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

const [username, flag] = process.argv.slice(2);
if (!username || /[^A-Za-z0-9_.@-]/.test(username)) {
  console.error("usage: node scripts/set-password.mjs <username> [--local]");
  process.exit(1);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const pw = await askHidden(`New password for ${username}: `);
if (pw.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}
const iter = 100000;
const salt = randomBytes(12).toString("base64url");
const hash = `pbkdf2_sha256$${iter}$${salt}$${pbkdf2Sync(pw, salt, iter, 32, "sha256").toString("hex")}`;
const sql = `INSERT INTO users(username, pw_hash) VALUES ('${username}', '${hash}') ` +
  `ON CONFLICT(username) DO UPDATE SET pw_hash = excluded.pw_hash;`;

execFileSync("npx", ["wrangler", "d1", "execute", "accessctl", flag === "--local" ? "--local" : "--remote", "--command", sql],
  { stdio: "inherit" });
console.log("Done.");
