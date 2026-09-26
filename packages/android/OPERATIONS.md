# Android client

## Build gates

```sh
pnpm --filter @agentstack/android build
pnpm --filter @agentstack/android test
pnpm --filter @agentstack/android test:android
pnpm --filter @agentstack/android build:apk
```

The normal pnpm/Turbo build prepares `dist/build-info.json`; the normal test
checks application identity, packaging, and assets without requiring an SDK.
The separate Android gates run JVM tests, Android lint, and assemble the actual
APK. Passing the lightweight gate does not substitute for those Android checks.

The checked-in wrapper pins Gradle 8.7 with AGP 8.5.2, Kotlin 1.9.24, JDK 17,
Android Platform 34, Build-Tools 34.0.0, and minimum Android 26. Point `JAVA_HOME`
and `ANDROID_HOME` to installed tools, or put `sdk.dir` in an untracked
`local.properties`. Do not use a current system Gradle in place of the wrapper.

Debug APK: `packages/android/app/build/outputs/apk/debug/app-debug.apk`.
JVM report: `app/build/reports/tests/testDebugUnitTest/index.html`.
Lint report: `app/build/reports/lint-results-debug.html`.
Installation and device checks are separate operator actions. Do not start an
emulator or access a real phone merely to build this package.

## Configure the app

The launcher is **AgentStack**, application ID and namespace `dev.agentstack.app`.
Root settings live in `dev.agentstack.app`; the current share feature lives in
`dev.agentstack.app.share`. This is a fresh app with no migration or copied data.

Configure the owner-managed Brain share listener as described in
[Brain operations](../../docs/brain.md) and the
[share contract](../../docs/brain-share-contract.md), then enter its reachable URL
and new AgentStack token in **Share to Brain**. The protocol default is
`http://127.0.0.1:8877`; on a phone that address means the phone itself. Replace it
with the actual AgentStack server address. **Save** stores the address and token
atomically in AgentStack-namespaced encrypted preferences. **Test connection**
checks `/v1/health` with the entered values.

HTTPS works with the platform trust store. The inherited cleartext policy permits
HTTP for `*.ts.net` tailnet names only. If your deployment uses a literal private IP,
add that exact domain to `app/src/main/res/xml/network_security_config.xml` and
rebuild, or use HTTPS. Never enable global cleartext as a workaround.

## Sharing and recovery

From another Android app, share `text/plain` to **AgentStack**. A bare URL becomes
`url`; prose becomes `text`, with URL resolution left to Brain. `EXTRA_SUBJECT`
becomes the title when distinct. Payload shape and `/v1` routes match the Chrome
client.

The outbox is persisted before the share Activity finishes. WorkManager retries
on a connected network, bounded at 200 held shares and seven days. **Held** means
no confirmed admission. **Admitted** and **Duplicate** acknowledge a job; they
do not claim indexing completion. Already-indexed content names its Document.
Malformed success receipts are ambiguous and remain held for idempotent retry.

Shares bind to the server address used for their first attempt; shares taken
before configuration bind to the first configured address. A server change
never silently reroutes held content. Restore the original address to retry it.
Rotating its token does not move its outbox. The API exposes no stable account or
database identity, so a different store behind the same URL cannot be detected.

The app retains the newest 20 shared links independently of admission. Android
13+ requires notification permission for existing local link reminders, with
**Open** and **Remove** actions; the list remains usable if permission is denied.
These are share reminders, not a general notifications feature. Removing a recent
link does not cancel delivery. **Discard held** stops local retries but cannot
undo an admission whose response was lost. Partial failures and abandoned shares
remain visible in settings.

### An unreadable outbox

If `agentstack.app.share.outbox.v1.json` is corrupt, truncated, invalid UTF-8, or
contains a malformed record, the app preserves its bytes and pauses delivery.
It does not skip bad rows, overwrite the file with an empty outbox, or let
**Discard held** erase an unreadable list. Settings displays recovery guidance;
new shares report that they were not sent or held. If corruption is discovered
after a server reply, the share result retains any confirmed admission separately
from the local storage problem. WorkManager records a terminal `outbox_unreadable`
failure with recovery text, without scheduling repeated retries.

Use developer assistance to copy the app-private file before attempting repair.
For an explicitly authorized debug-device session, `adb exec-out run-as
dev.agentstack.app cat files/agentstack.app.share.outbox.v1.json` can export it.
Keep that original copy and repair/restore verified records with the app stopped;
do not clear app storage or use uninstall as recovery. Missing intent cannot be
reconstructed from malformed bytes automatically. After restoring a valid file,
reopen Settings and choose **Send now**; resend a new share that the app explicitly
reported it could not hold. Destination bindings must be retained during repair.

Intentional discards are recorded as `DISCARDED` and read as **Discarded on this
device**. Only cap-driven eviction is `OVERFLOW` and reads as **Dropped because
the outbox was full**.

All app-owned preferences, keystore aliases, storage files, WorkManager names,
notification channels/groups, and intent identifiers have AgentStack identity.
Backup is disabled. Source settings, tokens, histories, endpoints, and user data
are never imported.

## Appearance and assets

System-aware DayNight native controls use AgentStack’s neutral canvas palette.
Visible labels, focus, 48dp targets, live status announcements, and wrapping text
are preserved. `pnpm --filter @agentstack/android icons` regenerates adaptive
launcher foreground/monochrome vectors, fallback PNGs, the in-app mark, and the
notification glyph from `assets/layers.svg`; raster generation uses
`rsvg-convert`. Normal builds use checked-in outputs. Source/license notices are
also packaged in the APK’s `assets/licenses/` directory.
