/** Bounded portable JSON transport. Redirects and ambient cookies are never authority. */
export async function responseJson(response: Response, family = "access") {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`invalid_${family}_response`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); throw new Error(`${family}_response_too_large`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || typeof body !== "object") throw new Error(`invalid_${family}_response`);
  return body;
}
