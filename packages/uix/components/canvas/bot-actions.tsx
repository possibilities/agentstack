"use client";

import { createContext, use, useId, useRef, useState } from "react";
import { PlayIcon, PlusIcon, Settings2Icon, SquareIcon, TerminalIcon, Trash2Icon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { accountLabels, shortId } from "@/lib/stack/derive";
import { BotUploads } from "@/lib/stack/bot-uploads";
import type { Bot, BotSettings } from "@/lib/stack/types";
import { useStack, useStore } from "./provider";
import { BotOperations } from "./bot-operations";

type Mode = "create" | "start" | "assign" | "stop" | "remove" | "defaults" | "tools";
type Target = { mode: Mode; bot?: Bot };
const ActionsContext = createContext<((mode: Mode, bot?: Bot) => void) | null>(null);

export function useBotActions() {
  const open = use(ActionsContext);
  if (!open) throw new Error("Bot actions require BotActionsProvider");
  return open;
}

export function BotActionsProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const store = useStore();
  const [uploads] = useState(() => new BotUploads((name, input) => store.call("bots", name, input)));
  return <ActionsContext value={(mode, bot) => setTarget({ mode, bot })}>
    {children}
    {target ? <BotDialog key={`${target.mode}:${target.bot?.id ?? ""}`} target={target} uploads={uploads} close={() => setTarget(null)} /> : null}
  </ActionsContext>;
}

export function BotWindowActions() {
  const open = useBotActions();
  const { status } = useStack();
  return <>
    <Button variant="ghost" size="icon-xs" aria-label="Edit Bot defaults" disabled={status.bots !== "open"} onClick={() => open("defaults")}><Settings2Icon /></Button>
    <Button size="xs" variant="outline" disabled={status.bots !== "open"} onClick={() => open("create")}><PlusIcon data-icon="inline-start" />Create Bot</Button>
  </>;
}

export function BotLifecycleControls({ bot, compact = false }: { bot: Bot; compact?: boolean }) {
  const open = useBotActions();
  const { status } = useStack();
  return <div className="flex flex-wrap gap-1.5">
    <Button size="xs" variant="outline" disabled={status.bots !== "open" || Boolean(bot.recoveryIssue)} onClick={() => open(bot.state === "running" ? "stop" : "start", bot)}>
      {bot.state === "running" ? <SquareIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}{bot.state === "running" ? "Stop…" : "Start…"}
    </Button>
    <Button size="xs" variant="outline" onClick={() => open("tools", bot)}><TerminalIcon data-icon="inline-start" />Bot tools</Button>
    {!compact ? <>
      <Button size="xs" variant="outline" disabled={status.bots !== "open"} onClick={() => open("assign", bot)}><UserRoundIcon data-icon="inline-start" />Assign account…</Button>
      <Button size="xs" variant="destructive" disabled={status.bots !== "open"} onClick={() => open("remove", bot)}><Trash2Icon data-icon="inline-start" />Remove…</Button>
    </> : null}
  </div>;
}

const settingOptions = {
  reasoningEffort: ["low", "medium", "high", "xhigh", "max", "ultra"],
  sandboxMode: ["read-only", "workspace-write", "danger-full-access"],
  approvalPolicy: ["untrusted", "on-failure", "on-request", "never"],
} as const;
const settingLabels = { model: "Model", reasoningEffort: "Reasoning effort", sandboxMode: "Sandbox", approvalPolicy: "Approval policy" };

function SettingsFields({ value, onChange, defaults }: { value: Partial<BotSettings>; onChange(value: Partial<BotSettings>): void; defaults: BotSettings | null }) {
  const id = useId();
  return <FieldGroup className="gap-4">
    <Field><FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel><Input id={`${id}-model`} value={value.model ?? ""} placeholder={defaults?.model ?? "Keep existing model"} onChange={(event) => onChange({ ...value, model: event.target.value })} /><FieldDescription>Codex Bot model ID. Worker catalogs belong to independent ACP sessions.</FieldDescription></Field>
    {(Object.keys(settingOptions) as Array<keyof typeof settingOptions>).map((key) => <Field key={key}>
      <FieldLabel htmlFor={`${id}-${key}`}>{settingLabels[key]}</FieldLabel>
      <NativeSelect id={`${id}-${key}`} value={value[key] ?? ""} onChange={(event) => onChange({ ...value, [key]: event.target.value })}>
        <NativeSelectOption value="">{defaults ? `Use ${defaults[key]}` : "Keep existing"}</NativeSelectOption>
        {settingOptions[key].map((option) => <NativeSelectOption key={option} value={option}>{option}</NativeSelectOption>)}
      </NativeSelect>
    </Field>)}
  </FieldGroup>;
}

function BotDialog({ target, uploads, close }: { target: Target; uploads: BotUploads; close(): void }) {
  const state = useStack();
  const store = useStore();
  const { mode } = target;
  const bot = state.bots.data?.find((item) => item.id === target.bot?.id);
  const [account, setAccount] = useState(target.bot?.account ?? "");
  const [id, setId] = useState("");
  const [cwd, setCwd] = useState("");
  const [args, setArgs] = useState("");
  const [settings, setSettings] = useState<Partial<BotSettings>>(() => mode === "defaults" ? state.botDefaults.data ?? {} : {});
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const toolPendingRef = useRef(false);
  const [toolPending, setToolPending] = useState(false);
  const toolPendingChanged = (value: boolean) => { toolPendingRef.current = value; setToolPending(value); };
  const [error, setError] = useState<string | null>(null);
  const [argsInvalid, setArgsInvalid] = useState(false);
  const formId = useId();
  const labels = accountLabels(state.accounts.data);
  const titles: Record<Mode, string> = { create: "Create Bot", start: `Start ${target.bot?.id}`, assign: `Assign ${target.bot?.id}`, stop: `Stop ${target.bot?.id}?`, remove: `Remove ${target.bot?.id}?`, defaults: "Bot defaults", tools: `${target.bot?.id} · Bot tools` };
  const launch = mode === "create" || mode === "start";
  const descriptions: Record<Mode, string> = {
    create: "Start a new Bot under an explicitly selected enabled Codex Bot account.",
    start: "Resume this Bot with its saved assignment. Optional overrides apply to this launch and later starts.",
    assign: "Change the saved account assignment. A running Bot keeps its launched identity until you stop and start it.",
    stop: "Stop this Bot’s process. Its record, workspace, and main thread remain available for a later start.",
    remove: "Stop and delete this Bot, its private runtime, uploads, and owned private workspace. An external working directory is retained.",
    defaults: "Settings copied into future Bots. Existing Bots retain their saved settings.",
    tools: "Explore and invoke the Bot’s chat, history, queue, attachment, upload, and voice operations. Results are snapshots; refresh reads to inspect new state.",
  };
  const selectedAccount = state.accounts.data?.find((item) => item.id === account);
  const accountValid = selectedAccount?.enabled && !selectedAccount.removing;
  const invalid = Boolean(target.bot && !bot) || state.status.bots !== "open" || (launch && (!accountValid || (bot && (bot.state !== "stopped" || Boolean(bot.recoveryIssue))))) || (mode === "assign" && !accountValid);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pendingRef.current || invalid) return;
    setError(null);
    setArgsInvalid(false);
    let input: Record<string, unknown> = bot ? { id: bot.id } : {};
    const savedSettings = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== ""));
    if (launch) {
      input = { ...input, account, ...(id.trim() && !bot ? { id: id.trim() } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(Object.keys(savedSettings).length ? { settings: savedSettings } : {}) };
      if (args.trim()) {
        try {
          const parsed: unknown = JSON.parse(args);
          if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) throw new Error();
          input.args = parsed;
        } catch { setArgsInvalid(true); setError("Launch arguments must be a JSON array of strings, for example [\"-c\", \"key=value\"]."); return; }
      }
    } else if (mode === "assign") input.account = account;
    else if (mode === "defaults") input = savedSettings;
    const operation = mode === "defaults" ? "bot_defaults_set" : mode === "create" ? "bot_start" : `bot_${mode}`;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await store.call<Bot>("bots", operation, input);
      toast.success(mode === "defaults" ? "Bot defaults saved" : `${result.id ?? bot?.id} · ${mode === "create" || mode === "start" ? "started" : mode === "assign" ? "account assigned" : mode === "stop" ? "stopped" : "removed"}`);
      close();
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : String(cause)}. Inspect the refreshed Bot state before retrying an interrupted request.`); }
    finally { pendingRef.current = false; setPending(false); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !pendingRef.current && !toolPendingRef.current) close(); }}>
    <DialogContent showCloseButton={!pending && !toolPending} className={mode === "tools" ? "max-h-[90dvh] overflow-y-auto sm:max-w-3xl" : "max-h-[90dvh] overflow-y-auto sm:max-w-lg"}>
      <DialogHeader><DialogTitle>{titles[mode]}</DialogTitle><DialogDescription>{descriptions[mode]}</DialogDescription></DialogHeader>
      {mode === "tools" ? bot ? <BotOperations bot={bot} uploads={uploads} onPendingChange={toolPendingChanged} /> : <p>This Bot was removed.</p> : <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <FieldSet disabled={pending} aria-label="Bot settings">
        <FieldGroup className="gap-4">
          {launch || mode === "assign" ? <Field>
            <FieldLabel htmlFor={`${formId}-account`}>Codex Bot account</FieldLabel>
            <NativeSelect id={`${formId}-account`} value={account} required disabled={mode === "start"} onChange={(event) => setAccount(event.target.value)}>
              <NativeSelectOption value="">Choose an enabled account</NativeSelectOption>
              {(state.accounts.data ?? []).map((item) => <NativeSelectOption key={item.id} value={item.id} disabled={!item.enabled || item.removing}>{labels.get(item.id) ?? shortId(item.id)} · {shortId(item.id)}{!item.enabled ? " · disabled" : ""}{item.removing ? " · removing" : ""}</NativeSelectOption>)}
            </NativeSelect>
            {mode === "start" ? <FieldDescription>Use Assign account before starting under a different identity.</FieldDescription> : null}
            {!accountValid ? <FieldDescription>Choose an enabled Bot account. Add or enable one in Bot accounts if needed.</FieldDescription> : null}
          </Field> : null}
          {mode === "create" ? <Field><FieldLabel htmlFor={`${formId}-id`}>Bot ID (optional)</FieldLabel><Input id={`${formId}-id`} value={id} onChange={(event) => setId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" placeholder="Next bot-N" /></Field> : null}
          {launch ? <Field><FieldLabel htmlFor={`${formId}-cwd`}>Working directory (optional)</FieldLabel><Input id={`${formId}-cwd`} value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={bot?.cwd ?? "New private workspace"} /><FieldDescription>Leave blank to {bot ? "reuse its saved directory" : "create a private workspace"}.</FieldDescription></Field> : null}
          {launch ? <details><summary className="cursor-pointer text-sm font-medium">Launch settings and arguments</summary><div className="mt-4 flex flex-col gap-4">
            <SettingsFields value={settings} onChange={setSettings} defaults={bot?.settings ?? (mode === "create" ? state.botDefaults.data : null)} />
            <Field data-invalid={argsInvalid}><FieldLabel htmlFor={`${formId}-args`}>Extra arguments (JSON)</FieldLabel><Textarea id={`${formId}-args`} value={args} aria-invalid={argsInvalid} onChange={(event) => { setArgs(event.target.value); if (argsInvalid) { setArgsInvalid(false); setError(null); } }} placeholder={'["-c", "key=value"]'} /><FieldDescription>Blank preserves saved arguments; [] clears them. Arguments can override settings. AgentStack owns listen, identity, capabilities, and history.</FieldDescription></Field>
          </div></details> : null}
          {mode === "defaults" ? <SettingsFields value={settings} onChange={setSettings} defaults={state.botDefaults.data} /> : null}
        </FieldGroup>
        </FieldSet>
        {bot?.recoveryIssue ? <Alert><AlertDescription>{bot.recoveryIssue}</AlertDescription></Alert> : null}
        {target.bot && !bot ? <Alert><AlertDescription>This Bot is no longer present.</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={close}>Cancel</Button>
          <Button type="submit" variant={mode === "remove" || mode === "stop" ? "destructive" : "default"} disabled={pending || invalid}>
            {pending ? <Spinner data-icon="inline-start" /> : null}{mode === "defaults" ? "Save defaults" : mode === "assign" ? "Assign account" : mode === "create" ? "Create and start" : mode === "start" ? "Start Bot" : mode === "stop" ? "Stop Bot" : "Remove Bot"}
          </Button>
        </div>
      </form>}
    </DialogContent>
  </Dialog>;
}
