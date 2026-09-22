import { request } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const uiOrigin = "https://agentstack.localhost";

export function portlessCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PORTLESS: "1",
    PORTLESS_PORT: "443",
    PORTLESS_HTTPS: "1",
    PORTLESS_TLD: "localhost",
    PORTLESS_LAN: "0",
    PORTLESS_WILDCARD: "0",
    PORTLESS_TAILSCALE: "0",
    PORTLESS_FUNNEL: "0",
    PORTLESS_NGROK: "0",
    PORTLESS_SYNC_HOSTS: "0",
  };
}

export function portlessBin(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("portless"))), "cli.js");
}

export function portlessProxyReady(): Promise<boolean> {
  return new Promise((done) => {
    const probe = request(
      {
        hostname: "127.0.0.1",
        port: 443,
        path: "/",
        method: "HEAD",
        rejectUnauthorized: false,
        timeout: 2000,
      },
      (response) => {
        response.resume();
        done(response.headers["x-portless"] === "1");
      },
    );
    probe.on("error", () => done(false));
    probe.on("timeout", () => {
      probe.destroy();
      done(false);
    });
    probe.end();
  });
}

export async function launchThroughPortless(cliPath: string): Promise<number> {
  if (!(await portlessProxyReady())) {
    throw new Error(
      "The shared portless HTTPS proxy is unavailable on loopback port 443. Complete portless service install or portless proxy start, then retry agentstack serve.",
    );
  }
  const child = spawn(
    process.execPath,
    [portlessBin(), "--name", "agentstack", "--", process.execPath, cliPath, "serve", "--direct"],
    { stdio: "inherit", env: portlessCommandEnv() },
  );
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return await new Promise((resolve) => {
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
