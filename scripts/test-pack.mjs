import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "sendrepute-pack-"));
try {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", temporary], {
    cwd: root,
    encoding: "utf8",
  });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!tarball) throw new Error("pnpm pack did not report a tarball");
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", temporary], { encoding: "utf8" });
  if (extract.status !== 0) throw new Error(extract.stderr);
  const manifest = JSON.parse(await readFile(path.join(temporary, "package/package.json"), "utf8"));
  if (Object.keys(manifest.dependencies ?? {}).length) throw new Error("Packed SDK must not have runtime dependencies");
  const sdk = await import(pathToFileURL(path.join(temporary, "package/dist/index.js")));
  if (typeof sdk.SendReputeClient !== "function" || typeof sdk.decodeExportBytes !== "function") {
    throw new Error("Packed SDK public exports are unavailable");
  }
  console.log(`Verified standalone tarball: ${path.basename(tarball)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}