// Copy the Flask server's static files (style.css, fonts) so both servers share one copy,
// then build the Tailwind CSS used by the pages made from the UX Pilot designs.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "public"), { recursive: true, force: true });
mkdirSync(join(root, "public"), { recursive: true });
cpSync(join(root, "..", "server", "static"), join(root, "public", "static"), { recursive: true });

const tw = join(root, "node_modules", "tailwindcss", "lib", "cli.js");
const build = (config, input, output) =>
  execFileSync(process.execPath, [tw, "-c", join(root, config), "-i", join(root, "styles", input), "-o", join(root, "public", "static", output), "--minify"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
build("tailwind.config.cjs", "se.css", "se.css");
build("tailwind.base.config.cjs", "se-base.css", "se-base.css");
