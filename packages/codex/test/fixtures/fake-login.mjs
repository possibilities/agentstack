import { writeFileSync } from "node:fs";
import { join } from "node:path";

process.stderr.write("If your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?state=fake\n");
setTimeout(() => {
  writeFileSync(join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { refresh_token: "fixture-secret", access_token: "access", id_token: "fixture.jwt.signature" } }));
  process.exit(0);
}, 50);
