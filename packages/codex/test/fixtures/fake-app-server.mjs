#!/usr/bin/env node
import { createServer } from "node:http";

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
