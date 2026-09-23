import { ownerTree } from "./actions";
import { OwnerTree, type TreeNode } from "./agent-tree";
import "./style.css";

export default async function OwnerPage() {
  let initial: TreeNode[] | null;
  try {
    initial = await ownerTree();
  } catch {
    initial = null;
  }
  return (
    <div className="app-shell">
      <main aria-label="Owned processes">
        <OwnerTree initial={initial} />
      </main>
    </div>
  );
}
