import { codexEventsUrl, codexInputLog, codexTree, codexVersion } from "./actions";
import { CodexTree, type TreeNode } from "./agent-tree";
import { InputLog } from "./input-log";

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
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Running Codex agents">
        <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-lg font-[550]">Codex agents</h1>
          <span
            aria-label={`Installed runtime: codexnk ${version ?? "version unavailable"}`}
            title="Installed runtime for new servers; existing processes retain their loaded version."
            className="rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground"
          >
            {`codexnk ${version ?? "version unavailable"}`}
          </span>
        </header>
        <CodexTree initial={initial} eventsUrl={eventsUrl} />
        <InputLog tree={initial} log={inputLog} />
      </main>
    </div>
  );
}
