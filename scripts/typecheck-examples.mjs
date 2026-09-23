import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const examples = path.join(root, "examples");
const files = await readdir(examples).catch(() => []);
const sourceFiles = files.filter((name) => /\.(?:[cm]?[jt]s)$/.test(name));
if (sourceFiles.length) {
  const result = spawnSync("pnpm", [
    "exec", "tsc", "--noEmit", "--strict", "--allowJs", "--checkJs",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    ...sourceFiles.map((name) => path.join("examples", name)),
  ], { cwd: root, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}