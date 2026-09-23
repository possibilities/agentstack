import { codexEventsUrl, codexTree } from "./actions";
import { CodexTree, type TreeNode } from "./agent-tree";

export default async function CodexPage() {
  let initial: TreeNode[] | null;
  let eventsUrl: string | null;
  try {
    [initial, eventsUrl] = await Promise.all([codexTree(true), codexEventsUrl()]);
  } catch {
    initial = null;
    eventsUrl = null;
  }
  return (
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Running Codex agents">
        <CodexTree initial={initial} eventsUrl={eventsUrl} />
      </main>
    </div>
  );
}
