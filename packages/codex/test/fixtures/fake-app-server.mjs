#!/usr/bin/env node
import { createServer } from "node:http";

const listenIndex = process.argv.indexOf("--listen");
const listen = process.argv[listenIndex + 1];
if (!listen) {
  process.stderr.write("missing --listen\n");
  process.exit(1);
}
const port = Number(new URL(listen).port);
createServer((req, res) => {
  if (req.url === "/readyz") {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(404).end();
}).listen(port, "127.0.0.1");
