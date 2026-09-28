import assert from "node:assert/strict";
import test from "node:test";
import { serveHttp } from "../src/http.js";
import { get } from "node:http";

function request(url: string, host: string): Promise<{ status: number | undefined; cookies: string[] | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { host } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, cookies: response.headers["set-cookie"], text }));
    }).on("error", reject);
  });
}

test("loopback HTTP rejects rebound Hosts before dispatch and preserves separate cookies", async () => {
  let calls = 0;
  const served = await serveHttp({ host: "127.0.0.1", port: 0, handle() {
    calls++;
    const headers = new Headers();
    headers.append("set-cookie", "first=1; HttpOnly");
    headers.append("set-cookie", "second=2; HttpOnly");
    return new Response("private", { headers });
  } });
  const url = `http://127.0.0.1:${served.port}/`;
  try {
    for (const host of ["rebind.example", `rebind.example:${served.port}`, "127.0.0.1:1"]) {
      assert.equal((await request(url, host)).status, 403);
    }
    assert.equal(calls, 0);
    for (const host of [`127.0.0.1:${served.port}`, `localhost:${served.port}`]) {
      const response = await request(url, host);
      assert.equal(response.text, "private");
      assert.deepEqual(response.cookies, ["first=1; HttpOnly", "second=2; HttpOnly"]);
    }
    assert.equal(calls, 2);
  } finally { await served.close(); }
});
