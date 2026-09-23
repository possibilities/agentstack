import { ownerEventsUrl, ownerTree } from "./actions";
import { OwnerTree, type TreeNode } from "./agent-tree";

export default async function OwnerPage() {
  let initial: TreeNode[] | null;
  let eventsUrl: string | null;
  try {
    [initial, eventsUrl] = await Promise.all([ownerTree(), ownerEventsUrl()]);
  } catch {
    initial = null;
    eventsUrl = null;
  }
  return (
    <div className="mx-auto min-h-dvh w-[min(1920px,100%)] px-[clamp(12px,3vw,48px)] py-5 text-lg leading-normal [overflow-anchor:none] max-[480px]:py-3">
      <main aria-label="Owned processes">
        <h1 className="mb-3 text-lg font-[550]">Owned processes</h1>
        <OwnerTree initial={initial} eventsUrl={eventsUrl} />
      </main>
    </div>
  );
}
