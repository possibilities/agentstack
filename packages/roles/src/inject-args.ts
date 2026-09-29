export type Harness = "claude" | "codex" | "opencode";

export const injectUsage = `usage: stack roles inject [default|existing-role-name] -- <claude|codex|opencode> [native args...]

Omitting the Role, or using literal default, selects the catalog's default.
Other names match SQLite NOCASE (ASCII case-insensitive).
Starts a fresh, foreground native session with a private Role snapshot.
Resume, attach, background/remote sessions and capability/config overrides are
not supported. Unrecognized native options fail explicitly. Use -- before a
native prompt beginning with a dash.
Native built-ins and administrator policy still apply; this is not a sandbox.
Executables are resolved from PATH. Requires Claude's isolation flags, Codex's
no-daemon CLI, or the stable OpenCode 2.0.16 CLI matching the pinned private host.
Authentication is orthogonal to Role selection: Claude uses native auth;
OpenCode uses its ordinary native database, credential selection and refresh.
Settings-based Claude auth helpers are not imported; native keychain/env auth remains.
Codex reuses only CODEX_HOME/auth.json via symlink (file credential stores);
keyring-only login is not supported. Its private HOME also changes ~ expansion
and home-based tool configuration. Project/built-in Codex resources may still load.
Claude/OpenCode retain ordinary native history. Codex history stays under
STACK_STATE_DIR/roles/inject; no automatic deletion of transcripts. Generated
capability files/auth links are removed after children exit. SIGKILL cannot clean up.
Fresh-only prevents past transcripts carrying previous instructions into a launch;
it does not prevent the native UI from selecting existing history after startup.`;

// Parse option boundaries rather than inspecting prompt strings. An explicit,
// intentionally bounded native surface prevents new config/attachment switches
// from silently bypassing isolation after a native upgrade.
const flags: Record<Harness, { boolean: string; value: string; commands: string; utilities: string }> = {
  claude: {
    boolean: "h help v version p print verbose dangerously-skip-permissions allow-dangerously-skip-permissions include-partial-messages include-hook-events replay-user-messages forward-subagent-text no-session-persistence no-chrome brief exclude-dynamic-system-prompt-sections ax-screen-reader",
    value: "model effort fallback-model permission-mode permission-prompts permission-prompt-tool input-format output-format json-schema max-budget-usd max-turns n name session-id autocompact debug-file allowedTools allowed-tools disallowedTools disallowed-tools tools add-dir file betas",
    commands: "",
    utilities: "agents attach auth auto-mode doctor gateway import install logs mcp plugin plugins project respawn rm setup-token stop kill ultrareview update upgrade",
  },
  codex: {
    boolean: "h help V version oss search no-alt-screen no-daemon strict-config dangerously-bypass-approvals-and-sandbox approve-for-me ephemeral skip-git-repo-check json uncommitted",
    value: "m model local-provider s sandbox a ask-for-approval C cd add-dir i image color output-schema o output-last-message c config base commit title",
    commands: "exec e review",
    utilities: "agents login logout mcp plugin app-server remote-control app completion update doctor sandbox debug apply a resume queue archive delete migrate-rollouts unarchive fork cloud exec-server features help",
  },
  opencode: {
    boolean: "h help v version auto thinking print-logs replay no-replay",
    value: "m model agent format f file title prompt log-level replay-limit",
    commands: "run mini",
    utilities: "attach upgrade update uninstall acp api debug auth mcp plugin models stats session service reload pair serve web completion providers",
  },
};
const words = (text: string) => new Set(text.split(" ").filter(Boolean));

export function injectArguments(args: string[]): { role: string; harness: Harness; native: string[]; command?: string } {
  const separator = args.indexOf("--");
  if (separator < 0 || separator > 1 || args.length <= separator + 1) throw new Error(injectUsage);
  const role = separator === 0 ? "default" : args[0]!;
  if (!role || role.startsWith("-")) throw new Error(injectUsage);
  const harness = args[separator + 1];
  if (harness !== "claude" && harness !== "codex" && harness !== "opencode") throw new Error(injectUsage);
  const native = args.slice(separator + 2);
  const spec = flags[harness], booleans = words(spec.boolean), values = words(spec.value);
  let command: string | undefined;
  let positional = false;
  for (let i = 0; i < native.length; i++) {
    const token = native[i]!;
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") {
      if (!positional) {
        if ((!command && words(spec.utilities).has(token)) || (harness === "codex" && command && ["resume", "fork"].includes(token)))
          throw new Error(`${harness} ${token} is not a fresh foreground Role session`);
        if (!command && words(spec.commands).has(token)) { command = token; continue; }
        positional = true;
      }
      continue;
    }
    const long = token.startsWith("--");
    const equal = token.indexOf("=");
    const key = long ? token.slice(2, equal < 0 ? undefined : equal) : token.slice(1, 2);
    const inline = long ? (equal < 0 ? undefined : token.slice(equal + 1)) : (token.length > 2 ? token.slice(2) : undefined);
    if (harness === "claude" && ["d", "debug", "prompt-suggestions"].includes(key)) {
      if (inline === undefined && native[i + 1] !== undefined && !native[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (booleans.has(key) && inline === undefined) continue;
    if (!values.has(key)) throw new Error(`${harness} option ${long ? `--${key}` : `-${key}`} is not supported by roles inject (capability overrides and session attachment are excluded)`);
    const value = inline ?? native[++i];
    if (value === undefined) throw new Error(`${harness} option ${token} needs a value`);
    if (harness === "codex" && (key === "c" || key === "config")) {
      const setting = value.split("=", 1)[0]!.trim();
      if (!value.includes("=") || !["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "service_tier"].includes(setting))
        throw new Error("roles inject accepts Codex --config only for model, model_reasoning_effort, model_reasoning_summary, model_verbosity or service_tier");
    }
  }
  // Native subcommand detection precedes positionals; require the command first
  // so --server/--no-daemon can be placed in its actual parser scope.
  if (command && native[0] !== command) throw new Error(`put ${harness} ${command} before its native options`);
  return { role, harness, native, ...(command ? { command } : {}) };
}
