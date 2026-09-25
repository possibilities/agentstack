import { lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { connect } from "node:net";
import { dirname } from "node:path";

// Only owner startups use this lock. The other Package API sockets continue to
// refuse existing paths; recovering an arbitrary package's socket is unsafe.
export async function startWithOwnerSocketRecovery<T>(path: string, start: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.starting`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`owner socket startup is already in progress at ${lock}`);
    }
    throw error;
  }
  try {
    const prior = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (prior) {
      if (!prior.isSocket()) throw new Error(`owner socket path is not a socket: ${path}`);
      // A connection refused by the kernel is evidence of a dead listener;
      // timeouts and other errors are ambiguous and must not trigger removal.
      const result = await probe(path);
      if (result !== "ECONNREFUSED") throw new Error(`owner socket is not proven stale at ${path} (${result})`);
      const current = await lstat(path);
      if (!current.isSocket() || current.dev !== prior.dev || current.ino !== prior.ino) {
        throw new Error(`owner socket changed during recovery at ${path}`);
      }
      await rm(path);
    }
    // Keep the lock until the new owner has actually bound its socket.
    return await start();
  } finally {
    await rmdir(lock);
  }
}

function probe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const client = connect(path);
    const finish = (result: string) => {
      client.destroy();
      resolve(result);
    };
    client.setTimeout(1_000, () => finish("timeout"));
    client.once("connect", () => finish("listening"));
    client.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? "error"));
  });
}
