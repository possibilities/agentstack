# Chrome client

## Build and load

```sh
pnpm --filter @agentstack/chrome build
pnpm --filter @agentstack/chrome test
```

No JavaScript dependencies or bundler are needed. The distributable directory is
`packages/chrome/dist/agentstack-chrome/`. Open `chrome://extensions`, enable
Developer mode, and **Load unpacked** with that directory. Rebuild and click
**Reload** after changing the client. Loading/installing is an operator action.

## Connect to Brain

1. Configure the shared [Access ingress](../../docs/access.md) on the tailnet.
2. In **Settings**, enter its HTTPS origin without a path and choose **Pair**.
   Chrome grants host permission for that exact origin.
3. Approve the matching code in AgentStack **System → Access**, then check
   approval. **Check connection** authenticates against `/v1/access/me`.
   Stored credentials alone do not establish connectivity.

**Disconnect** confirms server revocation before clearing the credential.
**Forget locally** explicitly clears it without claiming revocation; revoke the
old credential in System → Access separately. Both preserve held shares.

Settings, credentials, history, and the outbox start empty in AgentStack-prefixed
`chrome.storage.local` keys. They are not imported or synced from another app or
browser. The extension cannot encrypt browser-local credentials independently
of the browser profile; keep the profile private.

## Share and recover

The toolbar popup offers **Send this page**, recent outcomes, **Send held**, and
**Settings**. Right-click a page, link, or selection to send it to Brain.
`Ctrl+Shift+S` (`Command+Shift+S` on macOS) shares the active page. Resolve shortcut
collisions at `chrome://extensions/shortcuts`.

Every share is persisted before the first request. Admission acknowledges a job;
it does not establish indexing completion. A timeout or malformed receipt remains
held and retries with the same content-derived idempotency identity. A duplicate
acknowledges the same job, while already-indexed content names its Document.

Held shares and history bind to both URL and the server ID from pairing.
Shares created before setup bind on their first attempt. Refresh rotation and
re-pairing the same server preserve that identity; a replacement at the same URL
cannot receive old content. Legacy URL-only records remain held and are never
retargeted. Reconnect to the original identity, or explicitly discard and share
again. Other-destination records are retained beyond the normal retry age.

One alarm drives exponential retries from one minute to one hour. The outbox is
bounded at 200 entries and seven days. Permanent rejection, expiry, and overflow
are reported, including partial failure when other shares were admitted.
The last 20 outcomes are shown locally; while the popup is open it asks the server
for unfinished job states every three seconds. **Remove** and **Clear list** hide
history only, including later updates to a removed held row. **Discard held**
stops local redelivery; it cannot undo a request whose server receipt was lost.

## Assets and verification

`pnpm --filter @agentstack/chrome icons` regenerates 16/32/48/128 PNGs using
`rsvg-convert` (librsvg); ordinary builds use checked-in PNGs. The reproducible
vector source and license are in `assets/`. The Layers geometry matches the
canvas’s Lucide icon; light/dark neutrals follow `packages/ui/app/globals.css`.

Node tests cover inherited outbox/history behavior, delivery ambiguity,
destination isolation, concurrency, and the wire contract with fake browser
storage and a local HTTP server. A browser fixture, when used for visual review,
is synthetic; it never reads a real profile or sends a live share.

`node packages/chrome/scripts/render.mjs` from the workspace root runs an isolated
headless Chrome fixture and writes light/dark screenshots plus keyboard-focus
and overflow results to ignored `packages/chrome/evidence/`. Set `CHROME_BIN` if
Chrome is installed somewhere other than the standard macOS location. This checks
the real HTML/CSS/modules with synthetic browser APIs; actual extension installation
and live server delivery remain separate runtime checks.
