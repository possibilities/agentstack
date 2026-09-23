import { codexTree } from "./actions";
import { CodexTree, type TreeNode } from "./agent-tree";
import "./style.css";

export default async function CodexPage() {
  let initial: TreeNode[] | null;
  try {
    initial = await codexTree(false);
  } catch {
    initial = null;
  }
  return (
    <div className="app-shell">
      <main aria-label="Running Codex agents">
        <CodexTree initial={initial} />
      </main>
    </div>
  );
}
