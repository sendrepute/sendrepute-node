import { mkdtemp, readFile, rm, mkdir, writeFile, copyFile, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
  // Resolve public package exports from a standalone consumer, not workspace dist.
  await mkdir(path.join(temporary, "node_modules/@sendrepute"), { recursive: true });
  await symlink(path.join(temporary, "package"), path.join(temporary, "node_modules/@sendrepute/node"), "dir");
  await copyFile(path.join(root, "test/offline-network.cjs"), path.join(temporary, "offline-network.cjs"));
  await copyFile(path.join(root, "test/loopback-network.cjs"), path.join(temporary, "loopback-network.cjs"));
  for (const [file, from, to] of [
    ["client.test.mjs", "../dist/index.js", "@sendrepute/node"],
    ["native-fetch.test.mjs", "../dist/index.js", "@sendrepute/node"],
    ["nodemailer-matrix.test.mjs", "../dist/nodemailer.js", "@sendrepute/node/nodemailer"],
  ]) {
    const source = await readFile(path.join(root, "test", file), "utf8");
    if (!source.includes(`"${from}"`)) throw new Error(`Missing package import in ${file}`);
    await writeFile(path.join(temporary, file), source.replace(`"${from}"`, `"${to}"`));
  }
  // Build with the development toolchain; execute with each explicit consumer
  // runtime. No downloads, installs, credentials, or inherited NODE_OPTIONS here.
  const runtimes = process.argv.slice(2);
  for (const runtime of runtimes.length ? runtimes : [process.execPath]) {
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot"]
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    env.SENDREPUTE_MATRIX_MANIFEST = path.join(root, "package.json");
    const version = spawnSync(runtime, ["--version"], { env, encoding: "utf8" });
    if (version.status !== 0) throw new Error(`Cannot execute runtime ${runtime}: ${version.error ?? version.stderr}`);
    console.log(`Packed SDK runtime: ${version.stdout.trim()}`);
    const result = spawnSync(runtime, [
      "--require", path.join(temporary, "offline-network.cjs"),
      "--test", "client.test.mjs", "nodemailer-matrix.test.mjs",
    ], { cwd: temporary, env, stdio: "inherit", timeout: 120_000 });
    if (result.status !== 0) throw new Error(`Packed SDK failed on ${version.stdout.trim()}: ${result.error ?? result.status}`);
    console.log(`Packed SDK native fetch (loopback only): ${version.stdout.trim()}`);
    const native = spawnSync(runtime, [
      "--require", path.join(temporary, "loopback-network.cjs"),
      "--test", "native-fetch.test.mjs",
    ], { cwd: temporary, env, stdio: "inherit", timeout: 120_000 });
    if (native.status !== 0) throw new Error(`Packed native fetch failed on ${version.stdout.trim()}: ${native.error ?? native.status}`);
  }
  console.log(`Verified standalone tarball: ${path.basename(tarball)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}