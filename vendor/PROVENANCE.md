# Linux x64 vendor provenance

The ignored payload tree is reconstructed without using any globally installed
`codex` or `fx` binary:

```sh
scripts/vendor/fetch-node.sh
scripts/vendor/fetch-codex.sh
scripts/vendor/build-fx.sh /path/to/clean/possibilities-fx
scripts/vendor/verify.sh
```

`fetch-node.sh` accepts only the Node.js 24.21.0 official Linux x64 archive
whose SHA-256 appears in the signed Node.js checksum list. The checksum list's
signature was verified with fingerprint
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`.

`fetch-codex.sh` accepts only OpenAI's release asset
`codex-app-server-package-x86_64-unknown-linux-musl.tar.gz` from tag
`rust-v0.155.1`. GitHub reports the same required archive SHA-256 recorded in
the manifest. The archive is extracted without rearranging its upstream
layout, including `codex-code-mode-host`, ripgrep, bubblewrap, and the pinned
patched zsh helper.

`build-fx.sh` refuses a dirty checkout, a source commit other than
`e639de6aded41ae168a8888b920ff71db41877d0`, or a Zig compiler other than
0.16.0. It builds `x86_64-linux-musl` with `ReleaseSafe`; the result is a static
x86-64 ELF that embeds Fx version 0.0.10 and build revision `e639de6aded4`.

Two repeated clean Darwin arm64 builds produced
`3926591e083eed79330c8de74031c4a4679ea60ee1421e09128b35420f120e09`,
while one public Linux x86-64 CI observation (run `35537630615`) produced
`ce9837da78ff43181c7e180626d39582ea715cb246f1ba29dad68588308bd1ba`.
The earlier manifest incorrectly treated the Darwin cross-build digest as
universal. This difference does not establish its cause or prove that Linux
builds are repeatable. The Linux digest is a release candidate, not a qualified
artifact. CI now builds Fx twice from isolated caches and requires both bytes to
match each other and the candidate digest before staging. Qualification remains
pending until that repeated Linux evidence succeeds. The Darwin digest remains
a development observation and staging rejects it.

Node's official binary requires glibc 2.28 or newer. The Codex app-server,
code-mode host, ripgrep, and bubblewrap binaries are static PIE executables.
The Codex package's zsh helper is dynamically linked and references glibc 2.38,
so qualification of the complete upstream layout requires Debian 13 or another
host with glibc 2.38 or newer. This is a package compatibility boundary even
though the app-server entrypoint itself is static.

These checks verify bytes, architecture, executable mode, and Codex layout.
On Darwin they verify only the recorded cross-build observation; release staging
still refuses that Fx binary. These checks do not replace the required live
Debian handshake qualification.
