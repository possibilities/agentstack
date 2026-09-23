import { ownerTree } from "./actions";
import { OwnerTree, type TreeNode } from "./agent-tree";

export default async function OwnerPage() {
  let initial: TreeNode[] | null;
  try {
    initial = await ownerTree();
  } catch {
    initial = null;
  }
  return (
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Owned processes">
        <OwnerTree initial={initial} />
      </main>
    </div>
  );
}
