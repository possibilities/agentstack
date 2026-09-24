import { botsEventsUrl, botsTree } from "./actions";
import { CodexTree, type TreeNode } from "@agentstack/codex/ui/agent-tree";

export default async function BotsPage() {
  let initial: TreeNode[] | null;
  let eventsUrl: string | null;
  try {
    [initial, eventsUrl] = await Promise.all([botsTree(), botsEventsUrl()]);
  } catch {
    initial = null;
    eventsUrl = null;
  }
  return (
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Bots">
        <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-lg font-[550]">Bots</h1>
        </header>
        <h2 className="mb-2 text-base font-semibold">Bots</h2>
        <CodexTree initial={initial} eventsUrl={eventsUrl} emptyLabel="No bots yet" />
      </main>
    </div>
  );
}
