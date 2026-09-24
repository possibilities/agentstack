#!/usr/bin/env node
import { createServer } from "node:http";

if (process.argv.includes("--device-auth")) {
  process.stdout.write(`\nWelcome to Codex [v[90m0.0.0-test[0m]\n[90mOpenAI's command-line coding agent[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   [34mhttps://auth.openai.com/codex/device[0m\n\n2. Enter this one-time code [90m(expires in 15 minutes)[0m\n   [34mABCD-EFGH[0m\n\n[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.[0m\n`);
  setInterval(() => undefined, 60_000);
} else {

  const listenIndex = process.argv.indexOf("--listen");
  const listen = process.argv[listenIndex + 1];
  if (!listen) {
    process.stderr.write("missing --listen\n");
    process.exit(1);
  }
  const server = createServer((req, res) => {
    if (req.url === "/readyz") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  if (listen.startsWith("unix://")) server.listen(listen.slice("unix://".length));
  else server.listen(Number(new URL(listen).port), "127.0.0.1");
}
