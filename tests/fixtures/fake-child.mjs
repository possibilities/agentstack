import readline from "node:readline";

const mode = process.env.FAKE_MODE ?? "ready";
if (mode === "exit")
  setTimeout(() => process.exit(17), Number(process.env.FAKE_EXIT_MS ?? 5));

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.method !== "initialize") return;
  if (mode === "auth") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "authentication required" } })}\n`,
    );
    return;
  }
  if (mode === "invalid") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "initialize unsupported" } })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, fake: true, ppid: process.ppid } })}\n`,
  );
});

process.on("SIGTERM", () => {
  if (mode !== "ignore-term") process.exit(0);
});
