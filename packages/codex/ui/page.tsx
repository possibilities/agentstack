import { codexEventsUrl, codexInputLog, codexTree, codexVersion } from "./actions";
import { CodexTree, type TreeNode } from "./agent-tree";
import { InputLog } from "./input-log";
import { CodexShell } from "./layout";

export default async function CodexPage() {
  const version = await codexVersion();
  let initial: TreeNode[] | null;
  let eventsUrl: string | null;
  const inputLog = await codexInputLog();
  try {
    [initial, eventsUrl] = await Promise.all([codexTree(true), codexEventsUrl()]);
  } catch {
    initial = null;
    eventsUrl = null;
  }
  return (
    <CodexShell section="servers">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">Running servers</h2>
        <span
          aria-label={`Installed runtime: codexnk ${version ?? "version unavailable"}`}
          title="Installed runtime for new servers; existing processes retain their loaded version."
          className="rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground"
        >
          {`codexnk ${version ?? "version unavailable"}`}
        </span>
      </div>
      <CodexTree initial={initial} eventsUrl={eventsUrl} />
      <InputLog tree={initial} log={inputLog} />
    </CodexShell>
  );
}
