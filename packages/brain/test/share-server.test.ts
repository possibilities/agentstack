import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts.js";
import { generateShareToken } from "../src/share.js";
import { createShareHandler, startShareServer } from "../src/share-server.js";
import { ResearchStore } from "../src/store.js";

const roots: string[] = [];
const stores: ResearchStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const TOKEN = generateShareToken();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-share-server-"));
  roots.push(root);
  const store = new ResearchStore(join(root, "research.db"));
  stores.push(store);
  const events: string[] = [];
  const handler = createShareHandler({
    store,
    token: TOKEN,
    artifactStore: new ArtifactStore(join(root, "artifacts")),
    onEvent: (event) => events.push(`${event.status} ${event.outcome}`),
  });
  return { root, store, handler, events };
}

function shareRequest(body: unknown, token: string | null = TOKEN): Request {
  return new Request("http://share.test/v1/share", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("a URL share is admitted as a durable job", async () => {
  const { handler, store } = fixture();
  const response = await handler(
    shareRequest({ client: "chrome-extension", url: "https://example.com/a" }),
  );
  expect(response.status).toBe(200);

  const body = await json(response);
  expect(body.ok).toBe(true);
  const data = body.data as Record<string, unknown>;
  expect(data.status).toBe("queued");
  expect(data.resolved_kind).toBe("url");
  expect(data.resolved_url).toBe("https://example.com/a");

  const job = store.db
    .query("SELECT kind, state, intent FROM jobs WHERE id=?")
    .get(data.job_id as number) as {
    kind: string;
    state: string;
    intent: string;
  };
  expect(job.kind).toBe("url");
  expect(job.state).toBe("queued");
  // Ingress identity must survive into the durable intent so provenance shows
  // which client submitted the share.
  expect(JSON.parse(job.intent).ingress).toBe("chrome-extension");
});

test("replaying an identical share returns duplicate with the same job", async () => {
  const { handler, store } = fixture();
  const payload = { client: "android-share", url: "https://example.com/dup" };

  const first = await json(await handler(shareRequest(payload)));
  const second = await json(await handler(shareRequest(payload)));

  const a = first.data as Record<string, unknown>;
  const b = second.data as Record<string, unknown>;
  expect(a.status).toBe("queued");
  expect(b.status).toBe("duplicate");
  expect(b.job_id).toBe(a.job_id);
  expect(b.intent_hash).toBe(a.intent_hash);

  const count = store.db.query("SELECT COUNT(*) AS n FROM jobs").get() as {
    n: number;
  };
  expect(count.n).toBe(1);
});

test("the same link from different clients stays distinct provenance", async () => {
  const { handler, store } = fixture();
  await handler(
    shareRequest({ client: "chrome-extension", url: "https://example.com/x" }),
  );
  await handler(
    shareRequest({ client: "android-share", url: "https://example.com/x" }),
  );
  const count = store.db.query("SELECT COUNT(*) AS n FROM jobs").get() as {
    n: number;
  };
  expect(count.n).toBe(2);
});

test("an Android free-text share is admitted as the extracted URL", async () => {
  const { handler } = fixture();
  const body = await json(
    await handler(
      shareRequest({
        client: "android-share",
        text: "worth reading https://example.com/piece, really",
      }),
    ),
  );
  const data = body.data as Record<string, unknown>;
  expect(data.resolved_kind).toBe("url");
  expect(data.resolved_url).toBe("https://example.com/piece");
  expect(data.extracted_from_text).toBe(true);
});

test("a text-only share is admitted as a text job and never echoed back", async () => {
  const { handler } = fixture();
  const body = await json(
    await handler(
      shareRequest({ client: "android-share", text: "a private thought" }),
    ),
  );
  const data = body.data as Record<string, unknown>;
  expect(data.resolved_kind).toBe("text");
  expect(data.resolved_url).toBeNull();
  expect(JSON.stringify(body)).not.toContain("a private thought");
});

test("requests without a valid bearer token are refused before admission", async () => {
  const { handler, store } = fixture();
  for (const token of [null, "", "wrong-token-value-here"]) {
    const response = await handler(
      shareRequest(
        { client: "chrome-extension", url: "https://example.com/a" },
        token,
      ),
    );
    expect(response.status).toBe(401);
    const body = await json(response);
    expect(body.ok).toBe(false);
    expect((body.error as Record<string, string>).code).toBe("unauthorized");
  }
  const count = store.db.query("SELECT COUNT(*) AS n FROM jobs").get() as {
    n: number;
  };
  expect(count.n).toBe(0);
});

test("malformed and rejected payloads map onto their HTTP status", async () => {
  const { handler, store } = fixture();
  const cases: Array<[unknown, number, string]> = [
    ["{not json", 400, "bad_payload"],
    [{ client: "chrome-extension" }, 400, "bad_payload"],
    [
      { client: "unknown-client", url: "https://example.com/a" },
      400,
      "bad_payload",
    ],
    [
      { client: "chrome-extension", url: "file:///etc/passwd" },
      400,
      "bad_source",
    ],
    [
      { client: "chrome-extension", version: 9, url: "https://a.example/" },
      400,
      "unsupported_version",
    ],
  ];
  for (const [body, status, code] of cases) {
    const response = await handler(shareRequest(body));
    expect(response.status).toBe(status);
    expect(((await json(response)).error as Record<string, string>).code).toBe(
      code,
    );
  }
  const count = store.db.query("SELECT COUNT(*) AS n FROM jobs").get() as {
    n: number;
  };
  expect(count.n).toBe(0);
});

test("oversized bodies are refused without being parsed", async () => {
  const { handler } = fixture();
  const response = await handler(
    new Request("http://share.test/v1/share", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-length": "99999999",
      },
      body: JSON.stringify({ client: "android-share", text: "small" }),
    }),
  );
  expect(response.status).toBe(413);
});

test("a non-JSON content type is refused", async () => {
  const { handler } = fixture();
  const response = await handler(
    new Request("http://share.test/v1/share", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        authorization: `Bearer ${TOKEN}`,
      },
      body: "https://example.com/a",
    }),
  );
  expect(response.status).toBe(415);
});

test("routing rejects unknown paths and wrong methods", async () => {
  const { handler } = fixture();
  const auth = { authorization: `Bearer ${TOKEN}` };

  const unknown = await handler(
    new Request("http://share.test/v1/nope", { headers: auth }),
  );
  expect(unknown.status).toBe(404);

  const wrongMethod = await handler(
    new Request("http://share.test/v1/share", { headers: auth }),
  );
  expect(wrongMethod.status).toBe(405);

  const health = await handler(
    new Request("http://share.test/v1/health", { headers: auth }),
  );
  expect(health.status).toBe(200);

  // Health must not be an unauthenticated probe of a private index.
  const anonymousHealth = await handler(
    new Request("http://share.test/v1/health"),
  );
  expect(anonymousHealth.status).toBe(401);
});

test("a trailing slash resolves to the same endpoint", async () => {
  const { handler } = fixture();
  const response = await handler(
    new Request("http://share.test/v1/share/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        client: "chrome-extension",
        url: "https://example.com/slash",
      }),
    }),
  );
  expect(response.status).toBe(200);
});

test("CORS is granted to extension origins only", async () => {
  const { handler } = fixture();
  const extension = await handler(
    new Request("http://share.test/v1/share", {
      method: "OPTIONS",
      headers: { origin: "chrome-extension://abcdefghijklmnop" },
    }),
  );
  expect(extension.status).toBe(204);
  expect(extension.headers.get("access-control-allow-origin")).toBe(
    "chrome-extension://abcdefghijklmnop",
  );

  // A web page on the tailnet must not be able to read share responses.
  const webPage = await handler(
    new Request("http://share.test/v1/share", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }),
  );
  expect(webPage.headers.get("access-control-allow-origin")).toBeNull();
});

test("operational events record routing facts without shared content", async () => {
  const { handler, events } = fixture();
  await handler(
    shareRequest({
      client: "android-share",
      text: "secret note about https://example.com/private-thing",
    }),
  );
  await handler(shareRequest({ client: "chrome-extension" }));

  expect(events).toEqual(["200 queued", "400 bad_payload"]);
  expect(events.join(" ")).not.toContain("example.com");
  expect(events.join(" ")).not.toContain("secret");
});

test("the bound server accepts a real share over HTTP", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentstack-brain-share-live-"));
  roots.push(root);
  const store = new ResearchStore(join(root, "research.db"));
  stores.push(store);
  const running = await startShareServer({
    store,
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    artifactStore: new ArtifactStore(join(root, "artifacts")),
  });
  try {
    const response = await fetch(`${running.url}/v1/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        client: "chrome-extension",
        url: "https://example.com/live",
        title: "Live",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { status: string } };
    expect(body.data.status).toBe("queued");
  } finally {
    await running.stop();
  }
});

test("share states answer only for the ids asked about, and carry no locator", async () => {
  const { handler, store } = fixture();
  const admitted = await json(
    await handler(
      shareRequest({
        client: "chrome-extension",
        url: "https://example.com/state-probe",
        title: "State probe",
      }),
    ),
  );
  const jobId = (admitted.data as { job_id: number }).job_id;

  const response = await handler(
    new Request(
      `http://share.test/v1/shares?job_ids=${jobId},${jobId + 5000}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    ),
  );
  expect(response.status).toBe(200);
  const body = await json(response);
  const shares = (body.data as { shares: Array<Record<string, unknown>> })
    .shares;
  // The unknown id is absent rather than reported as missing: a client cannot
  // use this to learn whether an id it never received exists.
  expect(shares).toEqual([
    { job_id: jobId, state: "queued", failure_class: null, document_id: null },
  ]);
  const text = JSON.stringify(body);
  expect(text).not.toContain("example.com");
  expect(text).not.toContain("State probe");

  // A completed job reports the Document the share became.
  store.db.run("UPDATE jobs SET state='completed' WHERE id=?", [jobId]);
  const after = await json(
    await handler(
      new Request(`http://share.test/v1/shares?job_ids=${jobId}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    ),
  );
  expect(
    (after.data as { shares: Array<{ state: string }> }).shares[0]?.state,
  ).toBe("completed");
});

test("share states require the token, a GET, and a sane id list", async () => {
  const { handler } = fixture();

  const unauthenticated = await handler(
    new Request("http://share.test/v1/shares?job_ids=1"),
  );
  expect(unauthenticated.status).toBe(401);

  const wrongMethod = await handler(
    new Request("http://share.test/v1/shares?job_ids=1", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(wrongMethod.status).toBe(405);

  const malformed = await handler(
    new Request("http://share.test/v1/shares?job_ids=1,two", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(malformed.status).toBe(400);

  // Bounded: the client shows a bounded history, so a huge ask is not a use.
  const tooMany = await handler(
    new Request(
      `http://share.test/v1/shares?job_ids=${Array.from({ length: 51 }, (_, i) => i + 1).join(",")}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    ),
  );
  expect(tooMany.status).toBe(413);

  // No ids is an empty answer, not an error: a client with no history asks it.
  const empty = await handler(
    new Request("http://share.test/v1/shares", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  expect(empty.status).toBe(200);
  expect((await json(empty)).data).toMatchObject({ shares: [] });
});
