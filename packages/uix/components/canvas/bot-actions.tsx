"use client";

import { createContext, use, useId, useRef, useState } from "react";
import { ChevronRightIcon, EllipsisIcon, PhoneIcon, PlayIcon, PlusIcon, Settings2Icon, SquareIcon, TerminalIcon, Trash2Icon, UserRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountLabels, botsFor, shortId } from "@/lib/stack/derive";
import { BotUploads } from "@/lib/stack/bot-uploads";
import type { Account, Bot, BotSettings } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { Orb } from "./primitives";
import { useStack, useStore } from "./provider";
import { BotOperations } from "./bot-operations";
import { useVoice } from "./voice";

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
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Edit Bot defaults" disabled={status.bots !== "open"} onClick={() => open("defaults")} />}>
        <Settings2Icon />
      </TooltipTrigger>
      <TooltipContent side="bottom">Defaults</TooltipContent>
    </Tooltip>
    <Button size="xs" variant="outline" disabled={status.bots !== "open"} onClick={() => open("create")}><PlusIcon data-icon="inline-start" />Create Bot</Button>
  </>;
}

/** A Bot's actions: the lifecycle step it needs next, a call, its tools, and the rest in a menu. */
export function BotLifecycleControls({ bot }: { bot: Bot }) {
  const open = useBotActions();
  const voice = useVoice();
  const { status } = useStack();
  const offline = status.bots !== "open";
  const running = bot.state === "running";
  const onCall = voice.botId === bot.id;
  const callReason = voice.callable(bot);
  return <div className="flex items-center gap-1.5">
    <Button size="xs" variant={running ? "outline" : "secondary"} disabled={offline || Boolean(bot.recoveryIssue)} onClick={() => open(running ? "stop" : "start", bot)}>
      {running ? <SquareIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}{running ? "Stop…" : "Start…"}
    </Button>
    {!onCall ? (
      <Tooltip>
        <TooltipTrigger render={<span tabIndex={callReason ? 0 : -1} className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-ring" />}>
          <Button size="xs" variant="outline" disabled={callReason !== null || voice.busy} onClick={() => voice.dial(bot.id)}><PhoneIcon data-icon="inline-start" />Call</Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{callReason ?? "Call main thread"}</TooltipContent>
      </Tooltip>
    ) : null}
    <Button size="xs" variant="ghost" onClick={() => open("tools", bot)}><TerminalIcon data-icon="inline-start" />Tools</Button>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${bot.id} actions`} className="ml-auto" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={offline} onClick={() => open("assign", bot)}><UserRoundIcon />Assign account…</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" disabled={offline} onClick={() => open("remove", bot)}><Trash2Icon />Remove…</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

const settingOptions = {
  reasoningEffort: ["low", "medium", "high", "xhigh", "max", "ultra"],
  sandboxMode: ["read-only", "workspace-write", "danger-full-access"],
  approvalPolicy: ["untrusted", "on-failure", "on-request", "never"],
} as const;
const sandboxTitles: Record<BotSettings["sandboxMode"], string> = { "read-only": "Read only", "workspace-write": "Workspace", "danger-full-access": "Full access" };

/** Native radios styled as one segmented control; the empty value means "inherit". */
function Segmented({ legend, name, options, value, inherit, onChange, titles }: {
  legend: string;
  name: string;
  options: readonly string[];
  value: string;
  inherit: string;
  onChange(value: string): void;
  titles?: Record<string, string>;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-0.5 rounded-lg bg-muted p-0.5">
        {["", ...options].map((option) => (
          <label key={option || "inherit"}
            className="relative flex-1 cursor-pointer rounded-md px-2 py-1 text-center text-xs whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground has-checked:bg-background has-checked:font-medium has-checked:text-foreground has-checked:shadow-xs has-focus-visible:outline-2 has-focus-visible:outline-ring has-disabled:pointer-events-none has-disabled:opacity-50">
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} className="absolute inset-0 cursor-pointer appearance-none rounded-md opacity-0" />
            {option ? titles?.[option] ?? option : inherit}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SettingsFields({ value, onChange, defaults }: { value: Partial<BotSettings>; onChange(value: Partial<BotSettings>): void; defaults: BotSettings | null }) {
  const id = useId();
  const inherit = (key: keyof BotSettings) => defaults ? `Default · ${key === "sandboxMode" ? sandboxTitles[defaults.sandboxMode] ?? defaults.sandboxMode : defaults[key]}` : "Keep";
  return <FieldGroup className="gap-4">
    <Field>
      <FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel>
      <Input id={`${id}-model`} value={value.model ?? ""} placeholder={defaults?.model ?? "Keep current"} onChange={(event) => onChange({ ...value, model: event.target.value })} />
    </Field>
    <Segmented legend="Effort" name={`${id}-effort`} options={settingOptions.reasoningEffort} value={value.reasoningEffort ?? ""} inherit={defaults ? "Default" : "Keep"}
      onChange={(next) => onChange({ ...value, reasoningEffort: next as BotSettings["reasoningEffort"] })} />
    <div className="grid gap-4 sm:grid-cols-2">
      {(["sandboxMode", "approvalPolicy"] as const).map((key) => <Field key={key}>
        <FieldLabel htmlFor={`${id}-${key}`}>{key === "sandboxMode" ? "Sandbox" : "Approvals"}</FieldLabel>
        <NativeSelect id={`${id}-${key}`} className="w-full" value={value[key] ?? ""} onChange={(event) => onChange({ ...value, [key]: event.target.value })}>
          <NativeSelectOption value="">{inherit(key)}</NativeSelectOption>
          {settingOptions[key].map((option) => <NativeSelectOption key={option} value={option}>{key === "sandboxMode" ? sandboxTitles[option as BotSettings["sandboxMode"]] : option}</NativeSelectOption>)}
        </NativeSelect>
      </Field>)}
    </div>
  </FieldGroup>;
}

/** Bot accounts as a radio list: identity orb, label, and how many Bots already use it. */
function AccountPicker({ accounts, value, onChange, locked, labels, bots }: {
  accounts: Account[];
  value: string;
  onChange(value: string): void;
  locked: boolean;
  labels: Map<string, string>;
  bots: Bot[] | null;
}) {
  const shown = locked ? accounts.filter((account) => account.id === value) : accounts;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Account</legend>
      {shown.length ? (
        <div className="grid grid-cols-2 gap-1.5">
          {shown.map((account) => {
            const label = labels.get(account.id) ?? shortId(account.id);
            const unavailable = !account.enabled || account.removing;
            const used = botsFor(account.id, bots).length;
            return (
              <label key={account.id}
                className={cn("relative flex cursor-pointer items-center gap-2.5 rounded-xl border bg-background/50 px-2.5 py-2 transition-colors hover:border-foreground/20",
                  "has-checked:border-pkg-bots/60 has-checked:bg-pkg-bots/8 has-checked:ring-2 has-checked:ring-pkg-bots/20 has-focus-visible:outline-2 has-focus-visible:outline-ring",
                  (unavailable || locked) && "cursor-default hover:border-border", unavailable && "opacity-50")}>
                <input type="radio" name="bot-account" aria-label={label} value={account.id} checked={value === account.id} disabled={unavailable || locked} onChange={() => onChange(account.id)} className="absolute inset-0 z-10 cursor-pointer appearance-none rounded-xl opacity-0 disabled:cursor-default" />
                <Orb id={account.id} size="md" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{label}</span>
                  <span className="truncate text-[0.7rem] text-muted-foreground">
                    {account.removing ? "Removing" : !account.enabled ? "Disabled" : used ? `${used} bot${used === 1 ? "" : "s"}` : "Unused"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : <p className="rounded-xl border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">No Bot accounts yet</p>}
      {locked ? <FieldDescription>Assign a different account before starting.</FieldDescription> : null}
    </fieldset>
  );
}

function nextBotId(bots: Bot[] | null): string {
  const numbers = (bots ?? []).map((bot) => Number(/^bot-(\d+)$/.exec(bot.id)?.[1] ?? 0));
  return `bot-${Math.max(0, ...numbers) + 1}`;
}

function BotDialog({ target, uploads, close }: { target: Target; uploads: BotUploads; close(): void }) {
  const state = useStack();
  const store = useStore();
  const { mode } = target;
  const bot = state.bots.data?.find((item) => item.id === target.bot?.id);
  const labels = accountLabels(state.accounts.data);
  // Creating a Bot always takes an explicit account choice.
  const [account, setAccount] = useState(target.bot?.account ?? "");
  const [id, setId] = useState("");
  const [cwd, setCwd] = useState("");
  const [args, setArgs] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [settings, setSettings] = useState<Partial<BotSettings>>(() => mode === "defaults" ? state.botDefaults.data ?? {} : {});
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const toolPendingRef = useRef(false);
  const [toolPending, setToolPending] = useState(false);
  const toolPendingChanged = (value: boolean) => { toolPendingRef.current = value; setToolPending(value); };
  const [error, setError] = useState<string | null>(null);
  const [argsInvalid, setArgsInvalid] = useState(false);
  const formId = useId();
  const name = target.bot?.id;
  const titles: Record<Mode, string> = { create: "Create Bot", start: `Start ${name}`, assign: `Assign ${name}`, stop: `Stop ${name}?`, remove: `Remove ${name}?`, defaults: "Bot defaults", tools: `${name} tools` };
  const launch = mode === "create" || mode === "start";
  const descriptions: Record<Mode, string> = {
    create: "Starts under the chosen Bot account.",
    start: "Overrides apply to this and later starts.",
    assign: "Takes effect on the next start.",
    stop: "Keeps its record, workspace, and main thread.",
    remove: "Deletes its runtime, uploads, and private workspace. An external directory is kept.",
    defaults: "Applied to new Bots only.",
    tools: "Chat, history, queue, uploads, and voice.",
  };
  const submitLabels: Record<Exclude<Mode, "tools">, string> = { defaults: "Save defaults", assign: "Assign", create: "Create and start", start: "Start Bot", stop: "Stop Bot", remove: "Remove Bot" };
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
        } catch { setAdvanced(true); setArgsInvalid(true); setError("Arguments must be a JSON array of strings."); return; }
      }
    } else if (mode === "assign") input.account = account;
    else if (mode === "defaults") input = savedSettings;
    const operation = mode === "defaults" ? "bot_defaults_set" : mode === "create" ? "bot_start" : `bot_${mode}`;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await store.call<Bot>("bots", operation, input);
      toast.success(mode === "defaults" ? "Defaults saved" : `${result.id ?? bot?.id} ${launch ? "started" : mode === "assign" ? "assigned" : mode === "stop" ? "stopped" : "removed"}`);
      close();
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : String(cause)}. Check the Bot's state before retrying.`); }
    finally { pendingRef.current = false; setPending(false); }
  }

  const wide = mode === "tools";
  return <Dialog open onOpenChange={(open) => { if (!open && !pendingRef.current && !toolPendingRef.current) close(); }}>
    <DialogContent showCloseButton={!pending && !toolPending} className={cn("max-h-[90dvh] overflow-y-auto", wide ? "sm:max-w-3xl" : launch || mode === "defaults" ? "sm:max-w-md" : "sm:max-w-sm")}>
      <DialogHeader><DialogTitle>{titles[mode]}</DialogTitle><DialogDescription>{descriptions[mode]}</DialogDescription></DialogHeader>
      {mode === "tools" ? bot ? <BotOperations bot={bot} uploads={uploads} onPendingChange={toolPendingChanged} /> : <p>This Bot was removed.</p> : <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
        <FieldSet disabled={pending} aria-label="Bot settings" className="gap-5">
          {launch || mode === "assign" ? (
            <AccountPicker accounts={state.accounts.data ?? []} value={account} onChange={setAccount} locked={mode === "start"} labels={labels} bots={state.bots.data} />
          ) : null}
          {launch ? (
            <div className={cn("grid gap-4", mode === "create" && "grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
              {mode === "create" ? <Field><FieldLabel htmlFor={`${formId}-id`}>Name</FieldLabel><Input id={`${formId}-id`} value={id} onChange={(event) => setId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" placeholder={nextBotId(state.bots.data)} /></Field> : null}
              <Field><FieldLabel htmlFor={`${formId}-cwd`}>Workspace</FieldLabel><Input id={`${formId}-cwd`} value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={bot?.cwd ?? "Private"} className="font-mono text-xs" /></Field>
            </div>
          ) : null}
          {launch ? (
            <div className="flex flex-col gap-4">
              <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((open) => !open)}
                className="-mx-1 flex w-fit items-center gap-1 rounded-md px-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                <ChevronRightIcon className={cn("size-3.5 transition-transform", advanced && "rotate-90")} />
                Settings
              </button>
              {advanced ? (
                <div className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-3.5 motion-safe:animate-in motion-safe:fade-in-0">
                  <SettingsFields value={settings} onChange={setSettings} defaults={bot?.settings ?? (mode === "create" ? state.botDefaults.data : null)} />
                  <Field data-invalid={argsInvalid}>
                    <FieldLabel htmlFor={`${formId}-args`}>Arguments</FieldLabel>
                    <Textarea id={`${formId}-args`} value={args} rows={2} aria-invalid={argsInvalid} className="font-mono text-xs"
                      onChange={(event) => { setArgs(event.target.value); if (argsInvalid) { setArgsInvalid(false); setError(null); } }} placeholder={'["-c", "key=value"]'} />
                    <FieldDescription>JSON array. Blank keeps saved; [] clears.</FieldDescription>
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}
          {mode === "defaults" ? <SettingsFields value={settings} onChange={setSettings} defaults={state.botDefaults.data} /> : null}
        </FieldSet>
        {bot?.recoveryIssue ? <Alert><AlertDescription>{bot.recoveryIssue}</AlertDescription></Alert> : null}
        {target.bot && !bot ? <Alert><AlertDescription>This Bot is gone.</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={close}>Cancel</Button>
          <Button type="submit" variant={mode === "remove" || mode === "stop" ? "destructive" : "default"} disabled={pending || invalid}>
            {pending ? <Spinner data-icon="inline-start" /> : null}{submitLabels[mode]}
          </Button>
        </div>
      </form>}
    </DialogContent>
  </Dialog>;
}
