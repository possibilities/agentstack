# Portable Client UI candidates

`packages/ui` can prepare an **unpublished**, private `@stack/ui` candidate with
the provisional `stack-ui` bin. This is not a published npm name, available npx
command, platform runtime release, or Native SDK app. See
[the Client contract](client-bootstrap.md) and
[the desk navigation boundary](desk-navigation.md).

## Build and stage

Build the backend dependencies first, then run from the workspace root:

```sh
pnpm --filter @stack/ui run stage
```

The default destination is `packages/ui/dist/package`. An absolute alternative
can be passed after `stage`. The destination must not already exist: a failed
or previously verified candidate is never silently replaced. Stage preparation
does not install dependencies, approve scripts, publish, register services or
restart a process.

The stage command sets `STACK_UI_PORTABLE_BUILD=1` only for its build child.
Next uses `output: "standalone"`, monorepo tracing and `dist/next`; its packaging
TypeScript configuration is generated under `dist/`, not written into the
platform's source configuration. Ordinary `pnpm --filter @stack/ui build` still
builds `.next` with the existing configuration, and `packages/serve/src/ui.ts`
still invokes guarded `next start`. Do not enable portable output for a platform
build or substitute the generated standalone server for the Client ingress.

### Installed layout and authority

- `.next`: standalone server output plus the separately copied static assets.
  `public/`, when present, is copied too.
- `bin/stack-ui.mjs`, launcher, navigation and **custom client-server ingress**;
  `lib/client/security.mjs` and `release.mjs` are copied explicitly. Next does
  not trace custom servers. The unguarded generated `server.js` is not shipped.
- `next-runtime.json`: Next's serialized build configuration relocated to
  `.next`, without source-checkout roots. Only the launcher passes it to its
  supervised child through `__NEXT_PRIVATE_STANDALONE_CONFIG`, replacing any
  ambient value. The custom ingress still validates raw authority before Next.
- `node_modules`: actual installed runtime resolution, copied into ordinary
  npm directories. Version conflicts nest under their consumer; workspace
  packages supply compiled output, not TypeScript source or test suites. The
  stage has no symlinks, `workspace:` ranges, dependency lifecycle scripts,
  package-manager requirement or development dependencies. Every root runtime
  package is pinned and bundled; npm need not fetch dependencies at install.
- `stack-package-resources.json`: `{version:1,kind:"package-api-resources"}`
  identifies an installed resource root. `packages/<name>/api.yaml` supplies
  the existing, schema-validated Package API inventory through `workspaceRoot`
  and `listPackages`. These are metadata, not executable platform packages,
  live socket observations or authority to run a platform. No pnpm workspace
  marker or development checkout is required.
- `packaging.json`: installed runtime package/version/path inventory and explicit
  authoring/optional dependency omissions. It contains no build-machine paths.

The launcher retains Node `>=24`, immutable client mode, independent Client host
state and parent-only bootstrap minting. A platform release remains a separate
`bundleSchema` artifact with durable Node, `bin/stack`, prebuilt platform/UI
resources and the reviewed codexnk installer. This UI tarball is **not** that
bundle and cannot stand in for an operator-reviewed release manifest.

## Dependency build-script decisions

No pnpm build approvals are added. These decisions apply to the Client UI
candidate, not to unrelated platform packages or their installers.

| Dependency | Decision | Reason |
| --- | --- | --- |
| `@parcel/watcher@2.5.1` | Exclude from runtime; no install-script approval | A build/authoring watcher, not a production Client consumer. Existing builder prebuilt assets are not rebuilt or shipped by staging. |
| `msgpackr-extract@3.0.4` | Exclude; no install-script approval | Optional native acceleration used by unrelated tooling; the Client closure has no consumer. |
| `tree-sitter-bash@0.25.0` | Exclude; no install-script approval | Authoring/native parser, absent from Client host and Next production requirements. |
| `tree-sitter-powershell@0.25.10` | Exclude; no install-script approval | Same boundary; no parser or `node-gyp-build` needed at Client startup. |
| `@modelcontextprotocol/inspector@2.7.0` | Exclude; retain workspace denial | A separate Inspector app with a client-installing postinstall. The Client's SDK dependency is not the Inspector. |
| `shadcn` | Exclude authoring CLI and its closure | Components are built into the Next output. Shipping the generator would pull unnecessary native build tooling. |
| `tw-animate-css` | Exclude runtime package | CSS is already compiled into static assets. |
| `@next/swc-*` | Use existing builder prebuilt binary; exclude runtime compiler | The candidate runs precompiled output and serialized configuration; it does not compile Next/TypeScript on the installed machine. |
| `sharp` | Exclude optional runtime | Client UI uses no `next/image` optimizer; do not ship a target-specific image stack incidentally. A future optimized-image consumer requires revisiting this decision. |
| Optional Next build peers (`@playwright/test`, `sass`, `babel-plugin-react-compiler`) | Exclude | Test/build tools, not production Client requirements. |
| Publisher-only scripts (for example `ajv`'s `prepublish`) | Keep published JS; strip scripts | No source build or publishing occurs. Published runtime files are copied directly, and no lifecycle script is executed. |
| Any new runtime `preinstall`/`install`/`postinstall` | Refuse staging pending a specific review | Necessary native work must not be silently skipped or blanket-approved. |

## Fresh-HOME verification

```sh
STACK_UI_STAGE=/absolute/candidate \
CLIENT_PORTABLE_EVIDENCE_DIR=/absolute/scratch/evidence \
node packages/ui/test/client-portable-check.mjs
```

The check skips successfully if Node `>=24`, npm or a completed stage is absent.
It creates a short disposable `/tmp/s8d-*` HOME, empty cache, prefix and PATH
containing Node but **no pnpm**. npm uses two empty disposable configuration
files, packs the stage and installs the tarball **offline**, with scripts
disabled and no registry/audit/funding requests. No real HOME, npm settings,
global prefix or existing Client/platform state is modified.

The installed `stack-ui` bin runs outside the repository with disposable Client
and platform roots. Node filesystem permissions allow only that temporary tree;
a negative control proves reading the real repository fails. The same
permission configuration is inherited by the launcher and Next child. Child
process/worker permission is needed for this supervisor and is not an OS sandbox
claim. On newer Node versions network permission allows the loopback and Unix
socket checks. Observation-only service-manager stand-ins refuse mutations;
no launchd/systemd service is registered.

The check exercises the real one-use fragment-to-cookie exchange, `/client`,
Run locally, static assets, forwarding refusal, typed snapshot and offline
enrollment/QR RPC, authenticated SSE and launcher shutdown. It records bounded
JSON metrics and logs; npm's large file inventory stays in an evidence file.
Existing rendered Client checks separately own browser hydration, CSP and
platform `next start` compatibility. Neither check is a public npx smoke test.

## Release decisions still owned by the human

- Public npm name/scope ownership, version and release channel. Repository and
  stage identities remain private `@stack/ui@0.0.0` until decided.
- Signing/provenance policy for UI candidates and platform release bundles.
- Trusted release-manifest hosting, channel selection, hashes and size limits;
  untrusted platform descriptors cannot select install inputs.
- Runtime release production and validation: macOS arm64 and Debian x64 local
  execution initially; other targets remain remote-only until explicitly
  supported. A macOS check is not Debian or Node-24 qualification.
- Publication authorization and an actual public install/npx test after
  publication. No command in this runbook publishes anything.
