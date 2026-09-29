import { renderValue, type RenderContext } from "./conditions.js";

export type Harness = "claude" | "codex" | "opencode";

export const injectUsage = `usage: stack roles inject [default|existing-role-name] [--with-model VALUE] [--with-harness VALUE] -- <claude|codex|opencode> [native args...]

Omitting the Role, or using literal default, selects the catalog's default.
Other names match SQLite NOCASE (ASCII case-insensitive).
--with-model and --with-harness supply exact, case-sensitive fragment rendering
context only. They do not add native arguments or infer values from the command.
Both conditions must match when both are set; missing context does not match.
Starts a fresh, foreground native session with a private Role snapshot.
Resume, attach, background/remote sessions and capability/config overrides are
not supported. Other native options pass through to the harness for validation;
use -- before a native prompt beginning with a dash. New harness options are
not automatically evidence that the harness supports this isolation contract.
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

// These are the *boundary* switches, not a list of all allowed native options.
// Native CLIs own their evolving option grammar. Keep known isolation and
// attachment escapes out, then pass the rest through unchanged for native
// validation. Values only distinguish arguments from top-level subcommands.
const flags: Record<Harness, { blocked: string; shortBlocked: string; value: string; variadic?: string; commands: string; utilities: string }> = {
  claude: {
    blocked: "setting-sources settings mcp-config strict-mcp-config plugin-dir plugin-url append-system-prompt append-system-prompt-file system-prompt system-prompt-file system-prompt-snapshot agents agent client-data-url safe-mode bare bg background resume continue fork-session from-pr teleport cloud environment remote-control remote-control-session-name-prefix",
    shortBlocked: "c r",
    value: "model effort fallback-model permission-mode permission-prompts permission-prompt-tool input-format output-format json-schema max-budget-usd max-turns n name session-id autocompact debug-file allowedTools allowed-tools disallowedTools disallowed-tools tools add-dir file betas",
    variadic: "allowedTools allowed-tools disallowedTools disallowed-tools tools add-dir file betas",
    commands: "",
    utilities: "agents attach auth auto-mode doctor gateway import install logs mcp plugin plugins project respawn rm setup-token stop kill ultrareview update upgrade",
  },
  codex: {
    blocked: "remote remote-auth-token-env profile ignore-user-config",
    shortBlocked: "p",
    value: "m model local-provider s sandbox a ask-for-approval C cd add-dir i image color output-schema o output-last-message c config base commit title enable disable thread-source",
    commands: "exec e review",
    utilities: "agents login logout mcp plugin app-server remote-control app completion update doctor sandbox debug apply a resume queue archive delete migrate-rollouts unarchive fork cloud exec-server features help",
  },
  opencode: {
    blocked: "server standalone session continue fork",
    shortBlocked: "s c",
    value: "m model agent format f file title prompt log-level replay-limit completions",
    commands: "run mini",
    utilities: "attach upgrade update uninstall acp api debug auth mcp plugin models stats session service reload pair serve web completion providers",
  },
};
const words = (text: string) => new Set(text.split(" ").filter(Boolean));

export function injectArguments(args: string[]): { role: string; harness: Harness; native: string[]; command?: string; commandIndex?: number; context?: RenderContext } {
  const separator = args.indexOf("--");
  if (separator < 0 || args.length <= separator + 1) throw new Error(injectUsage);
  let role = "default", hasRole = false;
  const context: RenderContext = {};
  for (let i = 0; i < separator; i++) {
    const token = args[i]!;
    const [flag, ...inline] = token.split("=");
    if (flag === "--with-model" || flag === "--with-harness") {
      const key = flag === "--with-model" ? "model" : "harness";
      if (context[key] !== undefined) throw new Error(`duplicate ${flag}`);
      const value = inline.length ? inline.join("=") : ++i < separator ? args[i] : undefined;
      if (value === undefined || (!inline.length && value.startsWith("-"))) throw new Error(`${flag} needs a value`);
      context[key] = renderValue.parse(value);
    } else {
      if (!token || token.startsWith("-") || hasRole) throw new Error(injectUsage);
      role = token; hasRole = true;
    }
  }
  const harness = args[separator + 1];
  if (harness !== "claude" && harness !== "codex" && harness !== "opencode") throw new Error(injectUsage);
  const native = args.slice(separator + 2);
  const spec = flags[harness], blocked = words(spec.blocked), shortBlocked = words(spec.shortBlocked), values = words(spec.value), variadic = words(spec.variadic ?? "");
  let command: string | undefined, commandIndex: number | undefined;
  let positional = false;
  for (let i = 0; i < native.length; i++) {
    const token = native[i]!;
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") {
      if (!positional) {
        if ((!command && words(spec.utilities).has(token)) || (harness === "codex" && command && ["resume", "fork"].includes(token)))
          throw new Error(`${harness} ${token} is not a fresh foreground Role session`);
        if (!command && words(spec.commands).has(token)) { command = token; commandIndex = i; continue; }
        positional = true;
      }
      continue;
    }
    const long = token.startsWith("--");
    const equal = token.indexOf("=");
    const key = long ? token.slice(2, equal < 0 ? undefined : equal) : token.slice(1, 2);
    const inline = long ? (equal < 0 ? undefined : token.slice(equal + 1)) : (token.length > 2 ? token.slice(2) : undefined);
    if (long ? blocked.has(key) : shortBlocked.has(key))
      throw new Error(`${harness} option ${long ? `--${key}` : `-${key}`} bypasses a fresh private Role launch`);
    if (harness === "codex" && key === "no-daemon" && inline !== undefined)
      throw new Error("codex --no-daemon cannot be overridden");
    if (harness === "codex" && (key === "c" || key === "config")) {
      const value = inline ?? native[++i];
      if (value === undefined || (inline === undefined && value.startsWith("-") && value !== "-")) throw new Error(`codex option ${token} needs a value`);
      const setting = value.split("=", 1)[0]!.trim();
      if (!value.includes("=") || !["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "service_tier"].includes(setting))
        throw new Error("roles inject accepts Codex --config only for model, model_reasoning_effort, model_reasoning_summary, model_verbosity or service_tier");
      continue;
    }
    // A native CLI may interpret a short token as a cluster. A value-taking
    // first switch uses the rest as its value; other clusters cannot hide a
    // known short attachment/config escape after a harmless switch.
    if (!long && token.length > 2 && inline !== undefined && !values.has(key)) {
      if ([...token.slice(1)].some((char) => shortBlocked.has(char))) throw new Error(`${harness} option ${token} bypasses a fresh private Role launch`);
      continue;
    }
    if (harness === "claude" && ["d", "debug", "prompt-suggestions"].includes(key)) {
      if (inline === undefined && native[i + 1] !== undefined && !native[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (!values.has(key)) continue;
    const value = inline ?? native[++i];
    // Native parsers can interpret an option-looking next token as another
    // switch, rather than this value. Never let it escape the isolation checks.
    if (value === undefined || (inline === undefined && value.startsWith("-") && value !== "-"))
      throw new Error(`${harness} option ${token} needs a value (use = for a value beginning with a dash)`);
    if (inline === undefined && variadic.has(key)) while (native[i + 1] !== undefined && !native[i + 1]!.startsWith("-")) i++;
  }
  return { role, harness, native, ...(command ? { command, commandIndex } : {}), ...(Object.keys(context).length ? { context } : {}) };
}
