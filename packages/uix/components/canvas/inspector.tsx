"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRightIcon, BookOpenIcon, CircleCheckIcon, CopyIcon, LocateFixedIcon, LockIcon, PencilIcon, PhoneIcon, PhoneOffIcon, PinIcon, PinOffIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fieldsOf, findOperation, operationTitle, recordFields, recordOperations, type Field } from "@/lib/stack/catalog";
import { accountLabels, clockTime, providerTitle, shortId, workerAccountLabels } from "@/lib/stack/derive";
import { scopeTarget } from "@/lib/stack/resources";
import { base64Bytes, findCategory, findFragment, findResource, projectBots, type ResourceKind } from "@/lib/stack/roles";
import type { StackState } from "@/lib/stack/store";
import { nodeKey, type Account, type Bot, type Login, type NodeRef, type OperationDoc, type PackageDoc, type StackEvent, type WorkerAccount } from "@/lib/stack/types";
import { cn } from "@/lib/utils";
import { useAuthActions } from "./auth-actions";
import { CopyButton, Orb } from "./primitives";
import { BotLifecycleControls } from "./bot-actions";
import { CatalogRefresh, CatalogStatus } from "./catalog-window";
import { RecordTree } from "./record-tree";
import { ObservationStatus } from "./usage-window";
import { useNotifyActions } from "./notify-actions";
import { useOperation, useStack, useStore, useWorkbench } from "./provider";
import { useRoleActions } from "./role-actions";
import { useContentActions } from "./content-actions";
import { useVoice } from "./voice";
import { accentBg, accentText, type Accent } from "./window";
import { OperationBadges, RecoveryWarning } from "./windows";
import { AttentionItemDetail, AttentionMessageDetail, TraceViewer } from "./signal-windows";
import { useShowWorker } from "./worker-windows";
import { workerLabel } from "@/lib/stack/workers";
import { controllerKey, handoffOutcomes, handoffStates, heldBy, profileName } from "@/lib/stack/browse";

type View = {
  eyebrow: string;
  accent: Accent;
  title: string;
  orb?: string;
  record?: Record<string, unknown>;
  fields?: Map<string, Field>;
  related?: { ref: NodeRef; label: string }[];
  operations?: { pkg: string; list: OperationDoc[] };
  /** Live controls rendered above the operation list; their ops drop out of the list. */
  controls?: React.ReactNode;
  events?: StackEvent[];
  body?: React.ReactNode;
  recoveryIssue?: string | null;
};

function resolve(ref: NodeRef, state: StackState): View | null {
  const catalog = state.catalog.data;
  const labels = accountLabels(state.accounts.data);
  const workerLabels = workerAccountLabels(state.workerAccounts.data);
  const ownerFields = () => new Map(fieldsOf(findOperation(catalog, "owner", "owner_status")?.outputSchema).map((field) => [field.name, field]));
  const resourceItemFields = (list: string) =>
    new Map(fieldsOf(findOperation(catalog, "owner", "owner_resources")?.outputSchema).find((field) => field.name === list)?.children.map((field) => [field.name, field]) ?? []);
  switch (ref.kind) {
    case "access-client":
    case "access-pairing":
    case "access-grant":
    case "access-credential": {
      const list = { "access-client": "clients", "access-pairing": "pairings", "access-grant": "grants", "access-credential": "credentials" } as const;
      const record = state.access.data?.[list[ref.kind]].find((item) => item.id === ref.id);
      if (!record) return null;
      const fields = fieldsOf(findOperation(catalog, "access", "access_snapshot")?.outputSchema).find((field) => field.name === list[ref.kind]);
      return {
        eyebrow: ref.kind.replace("-", " "), accent: "owner", title: "label" in record ? record.label : record.id,
        record: { ...record }, fields: new Map(fields?.children.map((field) => [field.name, field])),
        related: [{ ref: { kind: "package", id: "access" }, label: "Access Package API" },
          ...("client_id" in record ? [{ ref: { kind: "access-client", id: record.client_id } as NodeRef, label: "Client" }] : []),
          ...("grant_id" in record ? [{ ref: { kind: "access-grant", id: record.grant_id } as NodeRef, label: "Grant" }] : [])],
        events: state.events.filter((event) => event.pkg === "access"),
      };
    }
    case "owner": {
      const owner = state.owner.data;
      if (!owner) return null;
      return {
        eyebrow: "Owner process", accent: "owner", title: `pid ${owner.pid}`, record: { ...owner, children: owner.children.map((child) => child.name) }, fields: ownerFields(),
        related: owner.children.map((child) => ({ ref: { kind: "child", id: child.name } as NodeRef, label: child.name })),
        events: state.events.filter((event) => event.pkg === "owner"),
      };
    }
    case "child": {
      const child = state.owner.data?.children.find((item) => item.name === ref.id);
      if (!child) return null;
      const known = catalog?.some((doc) => doc.name === child.name);
      const scopeId = `component:${encodeURIComponent(child.name)}`;
      const related: View["related"] = known ? [{ ref: { kind: "package", id: child.name }, label: `${child.name} Package API` }] : [];
      if (state.resources.data?.scopes.some((scope) => scope.id === scopeId)) related.push({ ref: { kind: "resource", id: scopeId }, label: "Component resources" });
      return {
        eyebrow: "Owned child", accent: "owner", title: child.name, record: child, fields: new Map(ownerFields().get("children")?.children.map((field) => [field.name, field])),
        related,
      };
    }
    case "resource": {
      const scope = state.resources.data?.scopes.find((item) => item.id === ref.id);
      if (!scope) return null;
      const target = scopeTarget(scope);
      const targetLabel = target ? target.kind === "owner" ? "Owner" : target.kind === "child" ? `${target.id} child` : target.kind === "bot" ? target.id : target.kind === "worker-account" ? `${workerLabels.get(target.id) ?? shortId(target.id)} Worker account` : target.kind === "account" ? `${labels.get(target.id) ?? shortId(target.id)} account` : "Process" : null;
      return {
        eyebrow: `${scope.kind} scope`, accent: "owner", title: scope.name, record: { ...scope }, fields: resourceItemFields("scopes"),
        related: target ? [{ ref: target, label: targetLabel! }] : [],
        events: state.events.filter((event) => event.pkg === "owner"),
      };
    }
    case "process": {
      const process = state.resources.data?.processes.find((item) => item.id === ref.id);
      if (!process) return null;
      const related: View["related"] = [];
      if (process.parentId && state.resources.data?.processes.some((item) => item.id === process.parentId)) related.push({ ref: { kind: "process", id: process.parentId }, label: "Parent process" });
      if (process.component === "owner") related.push({ ref: { kind: "owner" }, label: "Owner" });
      else if (state.owner.data?.children.some((child) => child.name === process.component)) related.push({ ref: { kind: "child", id: process.component }, label: `${process.component} child` });
      if (process.botId) related.push({ ref: { kind: "bot", id: process.botId }, label: process.botId });
      const scopeId = `component:${encodeURIComponent(process.component)}`;
      if (state.resources.data?.scopes.some((scope) => scope.id === scopeId)) related.push({ ref: { kind: "resource", id: scopeId }, label: "Component resources" });
      return {
        eyebrow: `Process · ${process.component}`, accent: "owner", title: `${process.name} · pid ${process.pid}`, record: { ...process }, fields: resourceItemFields("processes"),
        related,
      };
    }
    case "account": {
      const account = state.accounts.data?.find((item) => item.id === ref.id);
      if (!account) return null;
      const bound = (state.bots.data ?? []).filter((bot) => bot.account === account.id || bot.runningAccount === account.id);
      const linkedWorkers = (account.linkedAccounts ?? []).filter((link) => link.scope === "worker" && workerLabels.has(link.id));
      return {
        eyebrow: "Codex Bot account", accent: "auth", title: labels.get(account.id) ?? shortId(account.id), orb: account.id, record: account,
        fields: recordFields(catalog, "auth", "account_list"),
        related: [
          ...bound.map((bot) => ({ ref: { kind: "bot", id: bot.id } as NodeRef, label: bot.id })),
          ...linkedWorkers.map((link) => ({ ref: { kind: "worker-account", id: link.id } as NodeRef, label: `${workerLabels.get(link.id)} · same ChatGPT account` })),
        ],
        operations: { pkg: "auth", list: recordOperations(catalog, "auth").filter((operation) => !accountControls.has(operation.name) && !operation.name.startsWith("account_login") && !operation.name.startsWith("worker_account")) },
        controls: <AccountControls account={account} />,
        events: state.events.filter((event) => event.pkg === "auth"),
      };
    }
    case "worker-account": {
      const account = state.workerAccounts.data?.find((item) => item.id === ref.id);
      if (!account) return null;
      const linkedBots = (account.linkedAccounts ?? []).filter((link) => link.scope === "bot" && labels.has(link.id));
      return {
        eyebrow: `${providerTitle(account.provider)} Worker account`, accent: "auth", title: workerLabels.get(account.id) ?? shortId(account.id), orb: account.id, record: account,
        fields: recordFields(catalog, "auth", "worker_account_list"),
        related: [{ ref: { kind: "worker-catalog", id: account.id }, label: "Model catalog" }, ...linkedBots.map((link) => ({ ref: { kind: "account", id: link.id } as NodeRef, label: `${labels.get(link.id)} · same ChatGPT account` }))],
        operations: { pkg: "auth", list: recordOperations(catalog, "auth").filter((operation) => operation.name.startsWith("worker_account") && !workerControls.has(operation.name)) },
        controls: <WorkerAccountControls account={account} />,
        events: state.events.filter((event) => event.pkg === "auth"),
      };
    }
    case "login": {
      const login = state.login.data ?? state.attempt;
      if (!login) return null;
      return {
        eyebrow: "Device sign-in", accent: "auth", title: login.status === "pending" ? "Sign-in in progress" : `Sign-in ${login.status}`, record: login,
        fields: new Map(fieldsOf(findOperation(catalog, "auth", "account_login_status")?.outputSchema).map((field) => [field.name, field])),
        related: [login.account, login.targetAccount].filter((id): id is string => Boolean(id)).map((id) => ({ ref: { kind: "account", id }, label: labels.get(id) ?? shortId(id) })),
        operations: { pkg: "auth", list: (catalog?.find((doc) => doc.name === "auth")?.operations ?? []).filter((operation) => operation.name.startsWith("account_login") && !loginControls.has(operation.name)) },
        controls: <LoginControls login={login} />,
        events: state.events.filter((event) => event.topic === "login_changed"),
      };
    }
    case "usage": {
      const snapshot = state.usage.data;
      if (!snapshot) return null;
      return { eyebrow: "Usage snapshot", accent: "owner", title: "Usage", record: snapshot,
        fields: new Map(fieldsOf(findOperation(catalog, "usage", "usage_snapshot")?.outputSchema).map((field) => [field.name, field])),
        events: state.events.filter((event) => event.pkg === "usage") };
    }
    case "usage-account": {
      const account = state.usage.data?.accounts.find((item) => `${item.scope}:${item.id}` === ref.id);
      if (!account) return null;
      return { eyebrow: `${providerTitle(account.provider)} ${account.scope} usage`, accent: "owner", title: (account.scope === "bot" ? labels : workerLabels).get(account.id) ?? shortId(account.id), record: account,
        body: <ObservationStatus observation={account} />,
        related: [{ ref: { kind: account.scope === "bot" ? "account" : "worker-account", id: account.id }, label: "Account" }],
        events: state.events.filter((event) => event.pkg === "usage") };
    }
    case "grok-bot-usage": {
      const observation = state.usage.data?.grokBot;
      if (!observation) return null;
      return { eyebrow: "Grok Bot usage", accent: "owner", title: "Grok Bot", record: observation, body: <ObservationStatus observation={observation} /> };
    }
    case "worker-catalog": {
      const account = state.workerAccounts.data?.find((item) => item.id === ref.id);
      if (!account) return null;
      const resource = state.workerCatalogs[ref.id];
      return { eyebrow: `${providerTitle(account.provider)} Worker catalog`, accent: "bots", title: workerLabels.get(ref.id) ?? shortId(ref.id), record: resource?.data ?? { accountId: ref.id, error: resource?.error ?? "No observed catalog" },
        body: <CatalogStatus id={ref.id} />,
        controls: <CatalogRefresh ids={[ref.id]} />, related: [{ ref: { kind: "worker-account", id: ref.id }, label: "Worker account" }], events: state.events.filter((event) => event.pkg === "worker") };
    }
    case "bot": {
      const bot = state.bots.data?.find((item) => item.id === ref.id);
      if (!bot) return null;
      const related: View["related"] = [];
      if (bot.account) related.push({ ref: { kind: "account", id: bot.account }, label: `${labels.get(bot.account) ?? shortId(bot.account)} · assigned` });
      if (bot.runningAccount && bot.runningAccount !== bot.account) related.push({ ref: { kind: "account", id: bot.runningAccount }, label: `${labels.get(bot.runningAccount) ?? shortId(bot.runningAccount)} · ${bot.recoveryIssue ? "last launched" : "running"}` });
      return {
        eyebrow: "Bot", accent: "bots", title: bot.id, record: bot,
        recoveryIssue: bot.recoveryIssue,
        fields: recordFields(catalog, "bots", "bot_list"),
        related,
        controls: <BotControls bot={bot} />,
        events: state.events.filter((event) => event.scope === bot.id),
      };
    }
    case "chat":
    case "worker-window":
    case "browser-viewer":
      return null; // Chat, Worker and viewer windows are views onto a record, not records.
    case "worker": {
      const worker = state.workerStatuses[ref.id]?.data?.worker ?? state.workerSessions.data?.find((item) => item.id === ref.id);
      if (!worker) return null;
      const related: View["related"] = [];
      if (state.bots.data?.some((bot) => bot.id === worker.botId)) related.push({ ref: { kind: "bot", id: worker.botId }, label: `${worker.botId} · started it` });
      related.push({ ref: { kind: "worker-account", id: worker.accountId }, label: workerLabels.get(worker.accountId) ?? shortId(worker.accountId) });
      if (state.workerRuntimes.data?.some((runtime) => runtime.id === worker.accountId)) related.push({ ref: { kind: "worker-runtime", id: worker.accountId }, label: "Runtime" });
      return {
        eyebrow: `${providerTitle(worker.provider)} Worker · ${worker.phase.replace("_", " ")}`, accent: "worker", title: workerLabel(worker), record: worker,
        fields: recordFields(catalog, "worker", "worker_list"), related,
        // Bots start and steer Workers; only the reads are listed.
        operations: { pkg: "worker", list: recordOperations(catalog, "worker").filter((operation) => operation.annotations?.readOnlyHint) },
        controls: <WorkerRecordControls id={worker.id} />,
        events: state.events.filter((event) => event.pkg === "worker"),
      };
    }
    case "worker-runtime": {
      const runtime = state.workerRuntimes.data?.find((item) => item.id === ref.id);
      if (!runtime) return null;
      const related: View["related"] = [{ ref: { kind: "worker-account", id: runtime.id }, label: "Worker account" }, { ref: { kind: "worker-catalog", id: runtime.id }, label: "Model catalog" }];
      for (const pid of new Set([...(runtime.pid !== null ? [runtime.pid] : []), ...runtime.pids])) {
        const process = state.resources.data?.processes.find((item) => item.pid === pid);
        if (process) related.push({ ref: { kind: "process", id: process.id }, label: `pid ${pid}` });
      }
      return {
        eyebrow: `${providerTitle(runtime.provider)} Worker runtime · ${runtime.state}`, accent: "worker", title: workerLabels.get(runtime.id) ?? shortId(runtime.id), orb: runtime.id, record: runtime,
        fields: recordFields(catalog, "worker", "worker_runtime_list"), related,
        events: state.events.filter((event) => event.pkg === "worker"),
      };
    }
    case "category": {
      const found = findCategory(state.role.data, ref.id);
      if (!found) return null;
      const { category } = found;
      return {
        eyebrow: "Instruction category", accent: "roles", title: category.title,
        record: { ...category, fragments: category.fragments.map((fragment) => fragment.title) }, fields: roleFields(catalog).category,
        related: category.fragments.map((fragment) => ({ ref: { kind: "fragment", id: fragment.id } as NodeRef, label: fragment.title })),
        operations: { pkg: "roles", list: recordOperations(catalog, "roles").filter((operation) => operation.name.startsWith("category_")) },
        controls: <RoleRecordControls target={{ kind: "category", id: category.id }} />,
        events: state.events.filter((event) => event.pkg === "roles"),
      };
    }
    case "fragment": {
      const found = findFragment(state.role.data, ref.id);
      if (!found) return null;
      return {
        eyebrow: "Instruction fragment", accent: "roles", title: found.fragment.title, record: found.fragment, fields: roleFields(catalog).fragment,
        related: [{ ref: { kind: "category", id: found.category.id }, label: `${found.category.title} · category` }],
        operations: { pkg: "roles", list: recordOperations(catalog, "roles").filter((operation) => operation.name.startsWith("fragment_")) },
        controls: <RoleRecordControls target={{ kind: "fragment", id: found.fragment.id }} />,
        events: state.events.filter((event) => event.pkg === "roles"),
      };
    }
    case "notification": {
      const record = state.notificationRecords[ref.id];
      if (!record) return null;
      return {
        eyebrow: record.dismissedAt ? `Notification · ${record.outcome}` : "Notification · open", accent: "notify", title: record.title, record,
        fields: new Map(fieldsOf(findOperation(catalog, "notify", "notification_get")?.outputSchema).map((field) => [field.name, field])),
        operations: { pkg: "notify", list: recordOperations(catalog, "notify").filter((operation) => operation.name !== "notification_dismiss") },
        controls: <NotificationRecordControls id={record.id} />,
        events: state.events.filter((event) => event.pkg === "notify"),
      };
    }
    case "skill": {
      const skill = findResource(state.role.data?.skills, ref.id)?.item;
      if (!skill) return null;
      // Supporting files are listed by path and size; their base64 bytes would bury the record.
      return {
        eyebrow: "Role skill", accent: "roles", title: skill.name, fields: roleResourceFields(catalog, "skills"),
        record: { ...skill, files: skill.files.map((file) => ({ path: file.path, bytes: base64Bytes(file.contentBase64) })) },
        operations: { pkg: "roles", list: recordOperations(catalog, "roles").filter((operation) => operation.name.startsWith("skill_")) },
        controls: <RoleRecordControls target={{ kind: "skill", id: skill.id }} />,
        events: state.events.filter((event) => event.pkg === "roles"),
      };
    }
    case "mcp-server": {
      const server = findResource(state.role.data?.mcpServers, ref.id)?.item;
      if (!server) return null;
      return {
        eyebrow: "Role MCP server", accent: "roles", title: server.name, record: server, fields: roleResourceFields(catalog, "mcpServers"),
        operations: { pkg: "roles", list: recordOperations(catalog, "roles").filter((operation) => operation.name.startsWith("mcp_server_")) },
        controls: <RoleRecordControls target={{ kind: "mcp-server", id: server.id }} />,
        events: state.events.filter((event) => event.pkg === "roles"),
      };
    }
    case "trusted-project": {
      const project = findResource(state.role.data?.trustedProjects, ref.id)?.item;
      if (!project) return null;
      const inside = project.enabled && state.roleLaunch.data?.revision === state.role.data?.revision ? projectBots(state.roleLaunch.data, project.id, state.bots.data) : [];
      return {
        eyebrow: "Trusted project", accent: "roles", title: project.path, record: project, fields: roleResourceFields(catalog, "trustedProjects"),
        related: inside.map((bot) => ({ ref: { kind: "bot", id: bot.id } as NodeRef, label: `${bot.id} · runs inside` })),
        operations: { pkg: "roles", list: recordOperations(catalog, "roles").filter((operation) => operation.name.startsWith("project_")) },
        controls: <RoleRecordControls target={{ kind: "trusted-project", id: project.id }} />,
        events: state.events.filter((event) => event.pkg === "roles"),
      };
    }
    case "signal": {
      const status = state.signalStatus.data;
      if (!status) return null;
      return { eyebrow: "Signal processing", accent: "events", title: status.enabled ? "Interpreting" : "Paused", record: status,
        fields: new Map(fieldsOf(findOperation(catalog, "signal", "attention_status")?.outputSchema).map((field) => [field.name, field])),
        related: status.lastInference?.runId ? [{ ref: { kind: "attention-run", id: status.lastInference.runId }, label: "Last interpretation" }] : [],
        operations: { pkg: "signal", list: signalOperations(catalog, ["attention_control", "attention_defaults_set", "attention_models"]) },
        events: state.events.filter((event) => event.pkg === "signal") };
    }
    case "attention-item": {
      const item = state.signalRecords.items[ref.id];
      if (!item) return null;
      const related: View["related"] = [{ ref: { kind: "attention-message", id: item.messageId }, label: "Source message" }, { ref: { kind: "attention-run", id: item.runId }, label: "Interpretation run" }];
      if (item.botId && state.bots.data?.some((bot) => bot.id === item.botId)) related.push({ ref: { kind: "bot", id: item.botId }, label: item.botId });
      for (const relation of item.relations) if (relation.targetId) related.push({ ref: { kind: "attention-item", id: relation.targetId }, label: `${relation.type.replace("_", " ")} · ${state.signalRecords.items[relation.targetId]?.summary ?? relation.referenceText}` });
      return { eyebrow: `Attention · ${item.state}`, accent: "events", title: item.summary, record: item, fields: signalFields(catalog, "attention_list", "item"),
        body: <AttentionItemDetail item={item} />, related, operations: { pkg: "signal", list: signalOperations(catalog, ["attention_feedback"]) } };
    }
    case "attention-message": {
      // A message not yet listed still resolves: its body reads the immutable record by ID.
      const message = state.signalRecords.messages[ref.id];
      const related: View["related"] = message?.botId && state.bots.data?.some((bot) => bot.id === message.botId) ? [{ ref: { kind: "bot", id: message.botId }, label: message.botId }] : [];
      return { eyebrow: "Captured message", accent: "events", title: message ? `${message.role} · ${message.conversation}` : ref.id.slice(0, 12), record: message ?? { id: ref.id },
        fields: signalFields(catalog, "attention_message_list"), body: <AttentionMessageDetail id={ref.id} />, related,
        operations: { pkg: "signal", list: signalOperations(catalog, ["attention_message_read", "attention_blob_read", "attention_feedback"]) } };
    }
    case "attention-run": {
      const run = state.signalRecords.runs[ref.id];
      const related: View["related"] = [];
      if (run?.messageId) related.push({ ref: { kind: "attention-message", id: run.messageId }, label: "Interpreted message" });
      if (run?.replayOf) related.push({ ref: { kind: "attention-run", id: run.replayOf }, label: "Original run" });
      return { eyebrow: `Interpretation run${run?.replay ? " · replay" : ""}`, accent: "events", title: run ? `${run.state} · ${run.settings.model}` : ref.id.slice(0, 12), record: run ?? { id: ref.id },
        fields: signalFields(catalog, "attention_run_list"), body: <TraceViewer id={ref.id} state={run?.state} />, related,
        operations: { pkg: "signal", list: signalOperations(catalog, ["attention_trace_read", "attention_replay", "attention_feedback"]) } };
    }
    case "document": {
      const listed = state.contentDocuments.data?.find((item) => item.slug === ref.id);
      const record = state.contentRecords[nodeKey(ref)] ?? listed;
      if (!record) return null;
      return {
        eyebrow: "Vault document", accent: "content", title: String(record.title ?? ref.id), record,
        fields: new Map(fieldsOf(findOperation(catalog, "content", "get")?.outputSchema).map((field) => [field.name, field])),
        operations: { pkg: "content", list: recordOperations(catalog, "content").filter((operation) => ["get", "document_update", "links", "backlinks", "rm", "restore"].includes(operation.name)) },
        controls: <ContentRecordControls target={{ kind: "document", slug: ref.id }} />,
        events: state.events.filter((event) => event.pkg === "content"),
      };
    }
    case "item": {
      const record = state.contentRecords[nodeKey(ref)] ?? state.contentItems.data?.items.find((item) => item.id === ref.id);
      if (!record) return null;
      const collection = typeof record.collection === "string" ? record.collection : null;
      return {
        eyebrow: `Content item · ${String(record.kind)}`, accent: "content", title: String(record.name ?? ref.id), record,
        fields: contentItemFields(catalog),
        related: collection ? [{ ref: { kind: "collection", id: collection }, label: `${collection} · collection` }] : [],
        operations: { pkg: "content", list: recordOperations(catalog, "content").filter((operation) => operation.name.startsWith("item_")) },
        controls: record.kind === "document" ? <ContentRecordControls target={{ kind: "item", id: ref.id }} /> : undefined,
        events: state.events.filter((event) => event.pkg === "content"),
      };
    }
    case "collection": {
      const record = state.contentRecords[nodeKey(ref)] ?? state.contentLibrary.data?.collections.find((item) => item.slug === ref.id);
      if (!record) return null;
      const count = state.contentLibrary.data?.counts.byCollection[ref.id];
      return {
        eyebrow: "Content collection", accent: "content", title: String(record.title ?? ref.id), record: count === undefined ? record : { ...record, items: count },
        fields: new Map(fieldsOf(findOperation(catalog, "content", "collection_get")?.outputSchema).map((field) => [field.name, field])),
        operations: { pkg: "content", list: recordOperations(catalog, "content").filter((operation) => operation.name.startsWith("collection_")) },
        events: state.events.filter((event) => event.pkg === "content"),
      };
    }
    case "artifact": {
      const record = state.contentRecords[nodeKey(ref)] ?? state.contentArtifacts.data?.find((item) => item.name === ref.id);
      if (!record) return null;
      return {
        eyebrow: "Artifact", accent: "content", title: String(record.name ?? ref.id), record,
        fields: new Map(fieldsOf(findOperation(catalog, "content", "artifacts_show")?.outputSchema).map((field) => [field.name, field])),
        operations: { pkg: "content", list: recordOperations(catalog, "content").filter((operation) => operation.name.startsWith("artifacts_")) },
        events: state.events.filter((event) => event.pkg === "content"),
      };
    }
    case "preset": {
      const preset = state.scrapePresets.data?.find((item) => item.name === ref.id);
      if (!preset) return null;
      const configured = state.scrapeCanaries.data?.includes(preset.name);
      return {
        eyebrow: `Scrape preset · ${preset.source}${configured === undefined ? "" : configured ? " · canary configured" : " · no canary"}`, accent: "scrape", title: preset.name,
        record: preset, fields: scrapeFields(catalog, "scrape_presets_list", "presets"),
        operations: { pkg: "scrape", list: scrapeOperations(catalog, ["scrape_preset_show", "scrape_corpus_replay", "scrape_presets_check"]) },
      };
    }
    case "scrape-job": {
      const job = state.scrapeQueue.data?.jobs.find((item) => item.id === ref.id);
      if (!job) return null;
      return {
        eyebrow: `Scrape job · ${job.state}`, accent: "scrape", title: job.url ?? job.file, record: job, fields: scrapeFields(catalog, "scrape_queue_list", "jobs"),
        operations: { pkg: "scrape", list: scrapeOperations(catalog, ["scrape_queue_list", "scrape_queue_process"]) },
        events: state.events.filter((event) => event.pkg === "scrape"),
      };
    }
    case "browser-profile": {
      const profile = state.browserProfiles.data?.find((item) => item.id === ref.id);
      if (!profile) return null;
      const held = heldBy(profile.id, state.browserHandoffs.data);
      const related: View["related"] = [];
      if (profile.botId && state.bots.data?.some((bot) => bot.id === profile.botId)) related.push({ ref: { kind: "bot", id: profile.botId }, label: `${profile.botId} · ${profile.default ? "default profile" : "owns it"}` });
      if (held) related.push({ ref: { kind: "browser-handoff", id: held.id }, label: `Handoff · ${handoffStates[held.state].label}` });
      return {
        eyebrow: `Browser profile · ${profile.state}${profile.botId ? "" : " · unassigned"}`, accent: "browse", title: profileName(profile), record: profile,
        fields: browseFields(catalog, "browser_profile_list", "profiles"), related,
        operations: { pkg: "browse", list: browseOperations(catalog, ["browser_profile_list", "browser_profile_create", "browser_profile_delete"]) },
        events: state.events.filter((event) => event.pkg === "browse" && event.topic === "browser_profiles_changed"),
      };
    }
    case "browser-handoff": {
      const handoff = state.browserHandoffs.data?.find((item) => item.id === ref.id);
      if (!handoff) return null;
      const profile = state.browserProfiles.data?.find((item) => item.id === handoff.profileId);
      const related: View["related"] = [{ ref: { kind: "browser-profile", id: handoff.profileId }, label: `${profileName(profile, handoff.profileId)} · profile` }];
      if (state.bots.data?.some((bot) => bot.id === handoff.botId)) related.push({ ref: { kind: "bot", id: handoff.botId }, label: `${handoff.botId} · asked for help` });
      return {
        eyebrow: `Browser handoff · ${handoff.outcome ? handoffOutcomes[handoff.outcome] : handoffStates[handoff.state].label}`, accent: "browse", title: handoff.message.split("\n")[0].slice(0, 80) || "Handoff",
        record: handoff, fields: browseFields(catalog, "browser_handoff_list", "handoffs"), related,
        operations: { pkg: "browse", list: browseOperations(catalog, ["browser_handoff_get", "browser_handoff_take", "browser_handoff_finish"]) },
        events: state.events.filter((event) => event.pkg === "browse" && event.topic === "browser_handoffs_changed"),
      };
    }
    case "browser-controller": {
      const controller = state.browserControllers.data?.find((item) => controllerKey(item) === ref.id);
      if (!controller) return null;
      const related: View["related"] = [{ ref: { kind: "browser-profile", id: controller.profileId }, label: "Selected profile" }];
      if (controller.actualProfileId && controller.actualProfileId !== controller.profileId) related.push({ ref: { kind: "browser-profile", id: controller.actualProfileId }, label: "Actual profile" });
      if (state.bots.data?.some((bot) => bot.id === controller.botId)) related.push({ ref: { kind: "bot", id: controller.botId }, label: `${controller.botId} · launched it` });
      return {
        eyebrow: `Browser controller · ${controller.state}`, accent: "browse", title: `${controller.botId} · ${controller.session}`, record: controller,
        fields: browseFields(catalog, "browser_controller_list", "controllers"), related,
        operations: { pkg: "browse", list: browseOperations(catalog, ["browser_controller_list"]) },
      };
    }
    case "research-document": {
      const record = state.brainDocumentRecords[nodeKey(ref)];
      if (!record) return null;
      return {
        eyebrow: `Research document · ${String(record.content_kind ?? record.source_type ?? "")}`, accent: "brain", title: String(record.title ?? record.source_uri ?? `Document ${ref.id}`), record,
        fields: brainFields(catalog, "get"),
        operations: { pkg: "brain", list: brainOperations(catalog, ["get", "context", "delete"]) },
        body: <BrainHandOff label="Open in Reader" run={(store) => store.openBrainDocument(Number(ref.id))} target={ref} />,
      };
    }
    case "ingestion-job": {
      const id = Number(ref.id);
      const record = state.brainJobRecords[id]?.data ?? state.brainJobs.data?.jobs.find((job) => job.id === id);
      if (!record) return null;
      return {
        eyebrow: `Ingestion job · ${record.state.replace("_", " ")}`, accent: "brain", title: `Job ${record.id}`, record,
        fields: brainFields(catalog, "jobs_show"),
        operations: { pkg: "brain", list: brainOperations(catalog, ["jobs_show", "jobs_retry", "jobs_cancel", "jobs_exclude", "jobs_reveal"]) },
        events: state.events.filter((event) => event.pkg === "brain"),
      };
    }
    case "research-source": {
      const source = state.brainSources.data?.find((item) => item.id === ref.id);
      if (!source) return null;
      return {
        eyebrow: `Research source · ${source.kind}`, accent: "brain", title: source.display_name, record: source,
        fields: new Map((fieldsOf(findOperation(catalog, "brain", "sources_status")?.outputSchema).find((field) => field.name === "sources")?.children ?? []).map((field) => [field.name, field])),
        operations: { pkg: "brain", list: brainOperations(catalog, ["sources_show", "sources_sync", "sources_pause", "sources_resume"]) },
        events: state.events.filter((event) => event.pkg === "brain"),
      };
    }
    case "package":
    case "operation":
      return null; // Reference destinations are rendered in the shared dock's reading mode.
  }
}

function browseOperations(catalog: PackageDoc[] | null, names: string[]): OperationDoc[] {
  return catalog?.find((doc) => doc.name === "browse")?.operations.filter((operation) => names.includes(operation.name)) ?? [];
}

/** Field notes for one entry of a browse list output. */
function browseFields(catalog: PackageDoc[] | null, operation: string, list: string): Map<string, Field> {
  return new Map((fieldsOf(findOperation(catalog, "browse", operation)?.outputSchema).find((field) => field.name === list)?.children ?? []).map((field) => [field.name, field]));
}

function brainOperations(catalog: PackageDoc[] | null, names: string[]): OperationDoc[] {
  return catalog?.find((doc) => doc.name === "brain")?.operations.filter((operation) => names.includes(operation.name)) ?? [];
}

function brainFields(catalog: PackageDoc[] | null, operation: string): Map<string, Field> {
  return new Map(fieldsOf(findOperation(catalog, "brain", operation)?.outputSchema).map((field) => [field.name, field]));
}

/** Brain records are read and changed in their own windows; the inspector hands over to them. */
function BrainHandOff({ label, run, target }: { label: string; run(store: ReturnType<typeof useStore>): void; target: NodeRef }) {
  const store = useStore();
  const { goTo } = useWorkbench();
  return (
    <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => { run(store); goTo(target); }}>
      <ArrowRightIcon data-icon="inline-start" />{label}
    </Button>
  );
}

function scrapeOperations(catalog: PackageDoc[] | null, names: string[]): OperationDoc[] {
  return catalog?.find((doc) => doc.name === "scrape")?.operations.filter((operation) => names.includes(operation.name)) ?? [];
}

/** Field notes for one entry of a Scrape list output. */
function scrapeFields(catalog: PackageDoc[] | null, operation: string, list: string): Map<string, Field> {
  return new Map((fieldsOf(findOperation(catalog, "scrape", operation)?.outputSchema).find((field) => field.name === list)?.children ?? []).map((field) => [field.name, field]));
}

function signalOperations(catalog: PackageDoc[] | null, names: string[]): OperationDoc[] {
  return catalog?.find((doc) => doc.name === "signal")?.operations.filter((operation) => names.includes(operation.name)) ?? [];
}

/** Field notes for a Signal list's entries, optionally nested one level (attention_list wraps each item). */
function signalFields(catalog: PackageDoc[] | null, list: string, nested?: string): Map<string, Field> {
  const entries = fieldsOf(findOperation(catalog, "signal", list)?.outputSchema).find((field) => field.name === "entries")?.children ?? [];
  const fields = nested ? entries.find((field) => field.name === nested)?.children ?? [] : entries;
  return new Map(fields.map((field) => [field.name, field]));
}

/** Field notes for Content items, from item_get's output. */
function contentItemFields(catalog: PackageDoc[] | null): Map<string, Field> {
  return new Map(fieldsOf(findOperation(catalog, "content", "item_get")?.outputSchema).map((field) => [field.name, field]));
}

/** Editing lives in the Content space; the inspector hands documents and document items to its editor. */
function ContentRecordControls({ target }: { target: { kind: "document"; slug: string } | { kind: "item"; id: string } }) {
  const actions = useContentActions();
  const { goTo } = useWorkbench();
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={() => {
      actions.open(target.kind === "document" ? target : { kind: "item", id: target.id, itemKind: "document" });
      goTo(target.kind === "document" ? { kind: "document", id: target.slug } : { kind: "item", id: target.id });
    }}>
      <PencilIcon data-icon="inline-start" />Edit in Content
    </Button>
  );
}

const accountControls = new Set(["account_set_enabled", "account_remove", "account_login_replace"]);
const loginControls = new Set(["account_login_cancel", "account_login_status"]);
const workerControls = new Set(["worker_account_set_enabled", "worker_account_remove",
  "worker_account_login_start", "worker_account_login_status", "worker_account_login_current", "worker_account_login_submit", "worker_account_login_cancel"]);

/** Field notes for Role records, which nest inside role_snapshot's categories. */
function roleFields(catalog: PackageDoc[] | null): { category: Map<string, Field>; fragment: Map<string, Field> } {
  const categories = fieldsOf(findOperation(catalog, "roles", "role_snapshot")?.outputSchema).find((field) => field.name === "categories")?.children ?? [];
  const fragments = categories.find((field) => field.name === "fragments")?.children ?? [];
  return { category: new Map(categories.map((field) => [field.name, field])), fragment: new Map(fragments.map((field) => [field.name, field])) };
}

/** Field notes for skills, MCP servers and trusted projects, which role_snapshot lists at its top level. */
function roleResourceFields(catalog: PackageDoc[] | null, list: "skills" | "mcpServers" | "trustedProjects"): Map<string, Field> {
  const fields = fieldsOf(findOperation(catalog, "roles", "role_snapshot")?.outputSchema).find((field) => field.name === list)?.children ?? [];
  return new Map(fields.map((field) => [field.name, field]));
}

/** Editing lives in the Roles space; the inspector hands off to it. */
function RoleRecordControls({ target }: { target: { kind: "category" | "fragment" | ResourceKind; id: string } }) {
  const actions = useRoleActions();
  const { goTo } = useWorkbench();
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={() => { actions.open(target); goTo(target); }}>
      <PencilIcon data-icon="inline-start" />Edit in Roles
    </Button>
  );
}

/** The Worker window reads the conversation; the inspector hands off to it. */
function WorkerRecordControls({ id }: { id: string }) {
  const show = useShowWorker();
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={() => show(id)}>
      <ArrowRightIcon data-icon="inline-start" />Show in Worker window
    </Button>
  );
}

/** Answering and dismissing live in the Inbox; the inspector hands off to it. */
function NotificationRecordControls({ id }: { id: string }) {
  const actions = useNotifyActions();
  const { goTo } = useWorkbench();
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={() => { actions.open(id); goTo({ kind: "notification", id }); }}>
      <ArrowRightIcon data-icon="inline-start" />Open in Inbox
    </Button>
  );
}

function referencePackage(ref: NodeRef): string {
  if (ref.kind === "bot") return "bots";
  if (ref.kind === "owner" || ref.kind === "child" || ref.kind === "resource" || ref.kind === "process") return "owner";
  if (ref.kind === "category" || ref.kind === "fragment" || ref.kind === "skill" || ref.kind === "mcp-server" || ref.kind === "trusted-project") return "roles";
  if (ref.kind === "notification") return "notify";
  if (ref.kind === "document" || ref.kind === "collection" || ref.kind === "item" || ref.kind === "artifact") return "content";
  if (ref.kind === "worker-catalog" || ref.kind === "worker" || ref.kind === "worker-runtime" || ref.kind === "worker-window") return "worker";
  if (ref.kind === "usage" || ref.kind === "usage-account" || ref.kind === "grok-bot-usage") return "usage";
  if (ref.kind === "preset" || ref.kind === "scrape-job") return "scrape";
  if (ref.kind === "browser-profile" || ref.kind === "browser-handoff" || ref.kind === "browser-controller" || ref.kind === "browser-viewer") return "browse";
  if (ref.kind === "research-document" || ref.kind === "ingestion-job" || ref.kind === "research-source") return "brain";
  if (ref.kind === "signal" || ref.kind === "attention-item" || ref.kind === "attention-message" || ref.kind === "attention-run") return "signal";
  return "auth";
}

function BotControls({ bot }: { bot: Bot }) {
  const voice = useVoice();
  const onCall = voice.botId === bot.id;
  return (
    <div className="flex flex-col gap-1.5">
      <BotLifecycleControls bot={bot} />
      {onCall ? (
        <Button size="sm" variant="destructive" className="w-fit" disabled={voice.phase === "ending"} onClick={voice.hangup}>
          <PhoneOffIcon data-icon="inline-start" />
          Hang up
        </Button>
      ) : null}
    </div>
  );
}

function AccountControls({ account }: { account: Account }) {
  const actions = useAuthActions();
  const pending = actions.changingAvailability === account.id;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={account.removing || pending} onClick={() => actions.setEnabled(account, !account.enabled)}>
          {pending ? <Spinner data-icon="inline-start" /> : <CircleCheckIcon data-icon="inline-start" />}
          {account.enabled ? "Disable" : "Enable"}
        </Button>
        <Button size="sm" variant="outline" disabled={account.removing || actions.pendingSignIn} onClick={() => actions.startSignIn(account.id)}>
          <RefreshCwIcon data-icon="inline-start" />
          Sign in again
        </Button>
        <Button size="sm" variant="destructive" disabled={account.removing || actions.removing === account.id} onClick={() => actions.confirmRemove(account)}>
          <Trash2Icon data-icon="inline-start" />
          Remove…
        </Button>
      </div>
      {actions.error?.op === "availability" && actions.error.target === account.id ? (
        <p className="text-[0.72rem] text-pretty text-destructive">{actions.error.message}</p>
      ) : null}
      {account.removing ? (
        <p className="text-[0.72rem] text-muted-foreground">Removal started. {actions.removing === account.id ? "Removing…" : "Remove again to finish it."}</p>
      ) : null}
    </div>
  );
}

function WorkerAccountControls({ account }: { account: WorkerAccount }) {
  const worker = useAuthActions().worker;
  const { workerAttempts } = useStack();
  const pending = worker.changingAvailability === account.id;
  const attempt = workerAttempts[account.id];
  const signingIn = worker.signingIn === account.id || attempt?.status === "pending";
  const error = worker.error?.target === account.id ? worker.error.message : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={account.removing || pending} onClick={() => worker.setEnabled(account, !account.enabled)}>
          {pending ? <Spinner data-icon="inline-start" /> : <CircleCheckIcon data-icon="inline-start" />}
          {account.enabled ? "Disable" : "Enable"}
        </Button>
        {attempt?.status === "pending" ? (
          <Button size="sm" variant="outline" disabled={worker.cancelling === attempt.id} onClick={() => worker.cancel(attempt)}>
            {worker.cancelling === attempt.id ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}
            Cancel sign-in
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={account.removing || signingIn} onClick={() => void worker.signIn(account.provider, account.id)}>
            {worker.signingIn === account.id ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {account.ready ? "Sign in again" : "Sign in"}
          </Button>
        )}
        <Button size="sm" variant="destructive" disabled={account.removing || worker.removing === account.id} onClick={() => worker.confirmRemove(account)}>
          <Trash2Icon data-icon="inline-start" />
          Remove…
        </Button>
      </div>
      {error ? <p className="text-[0.72rem] text-pretty text-destructive">{error}</p> : null}
      {account.removing ? (
        <p className="text-[0.72rem] text-muted-foreground">Removal started. {worker.removing === account.id ? "Removing…" : "Remove again to finish it."}</p>
      ) : null}
    </div>
  );
}

function LoginControls({ login }: { login: Login }) {
  const actions = useAuthActions();
  const check = useOperation<Login>("auth", "account_login_status");
  const [result, setResult] = useState<Login | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {login.status === "pending" ? (
          <Button size="sm" variant="outline" disabled={actions.cancelPending} onClick={() => actions.cancelLogin(login.id)}>
            {actions.cancelPending ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}
            Cancel sign-in
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={check.pending} onClick={() => {
          void check.run({ id: login.id }).then(setResult, () => undefined);
        }}>
          {check.pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          Check status
        </Button>
        {login.authUrl ? (
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(login.authUrl ?? "").then(() => toast.success("Link copied")).catch(() => undefined)}>
            Copy link
            <CopyIcon data-icon="inline-end" />
          </Button>
        ) : null}
      </div>
      {result ? (
        <p className="flex items-center gap-1.5 text-[0.75rem]">
          <span className="text-muted-foreground">Latest:</span>
          <Badge variant={result.status === "failed" ? "destructive" : "secondary"} className="capitalize">{result.status}</Badge>
          {result.error ? <span className="text-destructive">{result.error}</span> : null}
          {result.account ? <span className="font-mono">{shortId(result.account)}</span> : null}
        </p>
      ) : null}
      {check.error ? <p className="text-[0.72rem] text-pretty text-destructive">{check.error}</p> : null}
    </div>
  );
}

function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/70 italic">null</span>;
  if (typeof value === "boolean") return <Badge variant={value ? "secondary" : "outline"} className="font-mono">{String(value)}</Badge>;
  if (typeof value === "number") return <span className="font-mono tabular-nums">{value}</span>;
  if (typeof value === "string") return <span className="font-mono break-all">{value}</span>;
  return <RecordTree value={value} />;
}

function Block({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[0.68rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Inspector({ hidden = false, onGone, pinned, onPinnedChange }: { hidden?: boolean; onGone: (ref: NodeRef) => void; pinned?: boolean; onPinnedChange?(pinned: boolean): void }) {
  const { selected, select, goTo } = useWorkbench();
  const state = useStack();
  // Keep the last selection mounted through the slide-out so the sheet never blanks.
  const last = useRef<NodeRef | null>(null);
  if (selected) last.current = selected;
  const shown = selected ?? last.current;
  const heading = useRef<HTMLHeadingElement>(null);
  const selectedKey = selected ? nodeKey(selected) : null;
  // A notification may be inspected before any Inbox page lists it.
  const store = useStore();
  const watched = selected?.kind === "notification" ? selected.id : null;
  useEffect(() => watched ? store.watchNotification(watched) : undefined, [store, watched]);
  useLayoutEffect(() => { if (!hidden && selectedKey) heading.current?.focus({ preventScroll: true }); }, [hidden, selectedKey]);

  const view = shown ? resolve(shown, state) : null;
  // Close an inspection whose record was present and has since been removed; a record that has not loaded yet stays open.
  const resolved = useRef<string | null>(null);
  const present = Boolean(selected && view);
  useEffect(() => {
    if (!selected || !selectedKey) { resolved.current = null; return; }
    if (present) resolved.current = selectedKey;
    else if (resolved.current === selectedKey) { resolved.current = null; onGone(selected); }
  }, [selected, selectedKey, present, onGone]);

  return (
    <section
      aria-label="Inspector"
      aria-hidden={hidden || !selected || undefined}
      inert={hidden || !selected}
      hidden={hidden || !selected}
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", (hidden || !selected) && "!hidden")}
    >
      {shown ? (
        <Fragment key={nodeKey(shown)}>
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
            {view?.orb ? <Orb id={view.orb} size="sm" /> : (
              <span className={cn("size-2.5 shrink-0 rounded-full", view ? accentBg[view.accent] : "bg-muted")} />
            )}
            <div className="flex min-w-0 flex-col">
              <span className={cn("text-[0.68rem] font-medium tracking-[0.08em] uppercase", view ? accentText[view.accent] : "text-muted-foreground")}>{view?.eyebrow ?? shown.kind}</span>
              <h2 ref={heading} data-inspector-heading tabIndex={-1} className="truncate text-lg leading-tight font-semibold tracking-tight outline-none">{view?.title ?? ("id" in shown ? shown.id : shown.kind)}</h2>
            </div>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Show on bench" onClick={() => goTo(shown)} />}>
                <LocateFixedIcon />
              </TooltipTrigger>
              <TooltipContent side="bottom">Show on bench</TooltipContent>
            </Tooltip>
            {onPinnedChange ? (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="aria-pressed:bg-muted" aria-label="Pin inspector" aria-pressed={pinned} onClick={() => onPinnedChange(!pinned)} />}>
                  {pinned ? <PinOffIcon /> : <PinIcon />}
                </TooltipTrigger>
                <TooltipContent side="bottom">{pinned ? "Unpin inspector" : "Pin inspector"}</TooltipContent>
              </Tooltip>
            ) : null}
            <Button variant="ghost" size="icon-sm" aria-label="Close inspector" onClick={() => select(null)}><XIcon /></Button>
          </header>
          <div data-scroll className="flex flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4">
            <Button variant="outline" size="sm" className="self-start" onClick={() => goTo({ kind: "package", id: referencePackage(shown) })}><BookOpenIcon data-icon="inline-start" />Package API reference</Button>
        {!view ? (
          <p className="text-sm text-muted-foreground">This item is gone.</p>
        ) : (
          <>
            {view.body}
            {view.recoveryIssue ? <RecoveryWarning message={view.recoveryIssue} /> : null}
            {view.record ? (
              <Block title="Fields" aside={<CopyButton value={JSON.stringify(view.record, null, 2)} label="JSON" className="opacity-100" />}>
                <dl className="flex flex-col divide-y rounded-xl border bg-background/50">
                  {Object.entries(view.record).map(([key, value]) => {
                    const field = view.fields?.get(key);
                    return (
                      <div key={key} className="flex flex-col gap-1 px-3 py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <dt className="font-mono text-[0.72rem] text-muted-foreground">{key}</dt>
                          {field ? <span className="font-mono text-[0.62rem] text-muted-foreground/70">{field.type}</span> : null}
                        </div>
                        <dd className="text-[0.8rem]"><Value value={value} /></dd>
                        {field?.description ? <p className="text-[0.7rem] text-pretty text-muted-foreground">{field.description}</p> : null}
                      </div>
                    );
                  })}
                </dl>
              </Block>
            ) : null}
            {view.related?.length ? (
              <Block title="Related">
                <div className="flex flex-wrap gap-1.5">
                  {view.related.map(({ ref, label }) => (
                    <Button key={nodeKey(ref)} variant="outline" size="sm" onClick={() => goTo(ref)}>
                      {label}<ArrowRightIcon data-icon="inline-end" />
                    </Button>
                  ))}
                </div>
              </Block>
            ) : null}
            {view.controls || view.operations?.list.length ? (
              <Block title="Actions" aside={view.controls ? undefined : <span className="flex items-center gap-1 text-[0.68rem] text-muted-foreground"><LockIcon className="size-3" />Read only for now</span>}>
                {view.controls}
                {view.operations?.list.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {view.operations.list.map((operation) => (
                      <li key={operation.name} className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-2">
                        <div className="flex min-w-0 flex-col">
                          <span className="text-[0.8rem] font-medium">{operationTitle(operation)}</span>
                          <span className="truncate font-mono text-[0.68rem] text-muted-foreground">{operation.name}</span>
                        </div>
                        <span className="ml-auto flex shrink-0 gap-1"><OperationBadges operation={operation} /></span>
                        <Tooltip>
                          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Go to ${operation.name}`} onClick={() => goTo({ kind: "operation", id: operation.name, pkg: view.operations!.pkg })} />}>
                            <ArrowRightIcon />
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-64">{operation.description}</TooltipContent>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Block>
            ) : null}
            {view.events ? (
              <Block title={`Notices · ${view.events.length}`}>
                {view.events.length ? (
                  <ol className="flex flex-col gap-1">
                    {view.events.slice(0, 12).map((event) => (
                      <li key={event.seq} className="flex items-center gap-2 font-mono text-[0.72rem]">
                        <span className="text-muted-foreground tabular-nums">{clockTime(event.at)}</span>
                        <span>{event.topic}</span>
                        <span className="ml-auto text-muted-foreground">{event.pkg}{event.scope ? ` · ${event.scope}` : ""}</span>
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-xs text-muted-foreground">No notices yet.</p>}
              </Block>
            ) : null}
          </>
        )}
          </div>
          <Separator />
          <footer className="flex shrink-0 items-center gap-2 px-4 py-2.5 text-[0.68rem] text-muted-foreground">
            Field notes come from the live discovery schema.
            <span className="ml-auto flex items-center gap-1"><kbd className="rounded border px-1 font-sans">Esc</kbd> close</span>
          </footer>
        </Fragment>
      ) : null}
    </section>
  );
}
