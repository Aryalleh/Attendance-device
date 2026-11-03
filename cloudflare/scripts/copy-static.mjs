// Copy the Flask server's static files (style.css, fonts) so both servers share one copy.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "public"), { recursive: true, force: true });
mkdirSync(join(root, "public"), { recursive: true });
cpSync(join(root, "..", "server", "static"), join(root, "public", "static"), { recursive: true });
