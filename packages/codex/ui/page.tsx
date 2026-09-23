import { codexTree } from "./actions";
import { CodexTree, type TreeNode } from "./agent-tree";

export default async function CodexPage() {
  let initial: TreeNode[] | null;
  try {
    initial = await codexTree(false);
  } catch {
    initial = null;
  }
  return (
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Running Codex agents">
        <CodexTree initial={initial} />
      </main>
    </div>
  );
}
