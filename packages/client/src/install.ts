import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { bundleSchema, releaseSchema, type Release } from "./contract.js";
import type { ClientState } from "./state.js";

export function installPlan(state: ClientState, input: Release) {
  const release = releaseSchema.parse(input);
  if (release.platform !== process.platform || release.architecture !== process.arch) throw new Error("release_platform_mismatch");
  if (!(process.platform === "darwin" && process.arch === "arm64" || process.platform === "linux" && process.arch === "x64")) throw new Error("runtime_platform_unsupported");
  if (!process.getuid || process.getuid() === 0) throw new Error("target_user_required");
  const directory = join(state.root, "releases", release.sha256);
  return { release, directory, platformState: join(state.root, "platform", "state"),
    requires: ["Node.js >=24", "python3", "GitHub CLI (gh)", process.platform === "darwin" ? "launchd user session" : "Debian with systemd user session"],
    effects: ["download pinned archive", "verify SHA-256 and size", "extract to a new private release",
      "invoke codexnk's pinned release installer at ~/.local/libexec/codexnk (no workshop required)", "select installed release"],
    startsPlatform: false, changesLogin: false };
}

export async function installRelease(state: ClientState, release: Release, progress: (stage: string) => void, signal: AbortSignal) {
  const plan = installPlan(state, release);
  const current = state.read<Release>("installation");
  if (current?.value.sha256 === release.sha256) return;
  const releases = join(state.root, "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const staging = join(releases, `.install-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  const archive = join(staging, "bundle.tgz"), unpacked = join(staging, "unpacked");
  try {
    progress("downloading");
    const response = await fetch(release.url, { redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) });
    if (!response.ok || !response.body) throw new Error("release_download_failed");
    let size = 0;
    const hash = createHash("sha256");
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > release.bytes) { callback(new Error("release_size_mismatch")); return; }
        hash.update(chunk); callback(null, chunk);
      },
    }), createWriteStream(archive, { mode: 0o600, flags: "wx" }), { signal });
    if (size !== release.bytes || hash.digest("hex") !== release.sha256) throw new Error("release_integrity_mismatch");
    progress("extracting");
    await mkdir(unpacked, { mode: 0o700 });
    let bytes = 0, entries = 0, refused = false;
    const paths = new Set<string>();
    let expanded = 0;
    const extractor = tar.x({ cwd: unpacked, strict: true, preservePaths: false, noChmod: true, filter(path, entry) {
      bytes += entry.size; entries++;
      const normalized = path.replace(/\/$/, "");
      const valid = path.length > 0 && path.length <= 4096 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => part === ".." || part === ".")
        && "type" in entry && ["File", "Directory"].includes(entry.type) && !paths.has(normalized) && entries <= 100_000 && bytes <= release.unpackedBytes;
      paths.add(normalized);
      if (!valid) refused = true;
      return valid;
    } });
    await pipeline(createReadStream(archive), createGunzip(), new Transform({ transform(chunk: Buffer, _encoding, callback) {
      expanded += chunk.length;
      // Bound gzip padding/metadata too, not only declared file payload sizes.
      callback(expanded > release.unpackedBytes + 103_448_576 ? new Error("release_expansion_limit") : null, chunk);
    } }), extractor, { signal });
    signal.throwIfAborted();
    if (refused) throw new Error("release_archive_refused");
    const manifestPath = join(unpacked, "stack-release.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.size > 4096) throw new Error("release_manifest_invalid");
    const manifest = bundleSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.version !== release.version || manifest.platform !== release.platform || manifest.architecture !== release.architecture) throw new Error("release_manifest_mismatch");
    // The launcher must be self-contained: absolute resources relative to its bundle,
    // with Node and the built UI supplied by the release producer. Runtime installation
    // stays with codexnk's authoritative installer, not a competing downloader.
    const launcher = join(unpacked, "bin", "stack");
    if (!(await lstat(launcher)).isFile()) throw new Error("release_launcher_missing");
    await chmod(launcher, 0o700); await access(launcher, constants.X_OK);
    const installer = join(unpacked, "runtime", "codexnk-install.py");
    if (!(await lstat(installer)).isFile()) throw new Error("runtime_installer_missing");
    progress("runtime_install");
    const env = { ...process.env }; delete env.CODEXNK_INSTALL_ROOT;
    await new Promise<void>((resolve, reject) => execFile("python3", [installer, "--install", "--tag", manifest.codexnk.tag, "--sha", manifest.codexnk.sha],
      { env, timeout: 600_000, maxBuffer: 65_536, signal }, error => error ? reject(new Error("runtime_install_failed")) : resolve()));
    await access(join(homedir(), ".local", "libexec", "codexnk", "codex"), constants.X_OK);
    await writeFile(join(unpacked, ".stack-client-release.json"), JSON.stringify(release), { mode: 0o600, flag: "wx" });
    progress("selecting");
    try { await rename(unpacked, plan.directory); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (await readFile(join(plan.directory, ".stack-client-release.json"), "utf8") !== JSON.stringify(release)) throw new Error("release_directory_conflict");
    }
    state.write("installation", release);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
