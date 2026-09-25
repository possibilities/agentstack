import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, linkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./workspace.js";

const botIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const workerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyFile = "mcp-bot-identity.key";

function identityKey(env: NodeJS.ProcessEnv): Buffer {
  const root = stateDir(env);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, keyFile);
  let info: ReturnType<typeof lstatSync> | undefined;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!info) {
    const temporary = join(root, `.${keyFile}-${randomBytes(8).toString("hex")}`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      try { writeFileSync(fd, randomBytes(32)); }
      finally { closeSync(fd); }
      try { linkSync(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temporary); }
    info = lstatSync(path);
  }
  if (!info.isFile() || info.isSymbolicLink() || (Number(info.mode) & 0o077) !== 0) throw new Error("MCP bot identity key must be a private regular file");
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("MCP bot identity key has an invalid length");
  return key;
}

export function botInstance(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
}

function proof(key: Buffer, botId: string, instance: string): Buffer {
  return createHmac("sha256", key).update(`bot-mcp-v1\0${botId}\0${instance}`).digest();
}

/** Mint a per-launch internal MCP URL without publishing its proof in discovery. */
export function botMcpUrl(base: string, botId: string, endpoint: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!botIdPattern.test(botId) || !endpoint) throw new Error("invalid bot MCP identity");
  const url = new URL(base);
  if (url.search) throw new Error("internal MCP base URL must have no query");
  const instance = botInstance(endpoint);
  url.searchParams.set("bot", botId);
  url.searchParams.set("instance", instance);
  url.searchParams.set("proof", proof(identityKey(env), botId, instance).toString("hex"));
  return url.toString();
}

/** A valid proof identifies its issuer and launch, not yet whether that Bot is live. */
export function parseBotMcpIdentity(url: URL, env: NodeJS.ProcessEnv = process.env): { botId: string; instance: string } | null {
  if (!url.search) return null;
  if ([...url.searchParams.keys()].sort().join(",") !== "bot,instance,proof") throw new Error("invalid bot MCP URL parameters");
  const botId = url.searchParams.get("bot") ?? "";
  const instance = url.searchParams.get("instance") ?? "";
  const raw = url.searchParams.get("proof") ?? "";
  if (!botIdPattern.test(botId) || !/^[0-9a-f]{32}$/.test(instance) || !/^[0-9a-f]{64}$/.test(raw)) throw new Error("invalid bot MCP identity");
  if (!timingSafeEqual(Buffer.from(raw, "hex"), proof(identityKey(env), botId, instance))) throw new Error("invalid bot MCP identity");
  return { botId, instance };
}

function workerProof(key: Buffer, workerId: string, instance: string): Buffer {
  return createHmac("sha256", key).update(`worker-mcp-v1\0${workerId}\0${instance}`).digest();
}

/** Mint an exact Worker/runtime-bound URL for one ACP session's internal MCP list. */
export function workerMcpUrl(base: string, workerId: string, instance: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!workerIdPattern.test(workerId) || !workerIdPattern.test(instance)) throw new Error("invalid worker MCP identity");
  const url = new URL(base);
  if (url.search) throw new Error("internal MCP base URL must have no query");
  url.searchParams.set("worker", workerId);
  url.searchParams.set("runtime", instance);
  url.searchParams.set("proof", workerProof(identityKey(env), workerId, instance).toString("hex"));
  return url.toString();
}

export function parseWorkerMcpIdentity(url: URL, env: NodeJS.ProcessEnv = process.env): { workerId: string; instance: string } | null {
  if (!url.search) return null;
  if ([...url.searchParams.keys()].sort().join(",") !== "proof,runtime,worker") throw new Error("invalid worker MCP URL parameters");
  const workerId = url.searchParams.get("worker") ?? "";
  const instance = url.searchParams.get("runtime") ?? "";
  const raw = url.searchParams.get("proof") ?? "";
  if (!workerIdPattern.test(workerId) || !workerIdPattern.test(instance) || !/^[0-9a-f]{64}$/.test(raw)) throw new Error("invalid worker MCP identity");
  if (!timingSafeEqual(Buffer.from(raw, "hex"), workerProof(identityKey(env), workerId, instance))) throw new Error("invalid worker MCP identity");
  return { workerId, instance };
}
