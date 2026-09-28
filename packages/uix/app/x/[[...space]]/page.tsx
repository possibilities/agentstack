import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { Workbench } from "@/components/canvas/workbench";
import { loadSnapshot } from "@/lib/stack/snapshot";
import { defaultSpace, isSpaceId, parseNodeKey, spaceTitle } from "@/lib/stack/spaces";
import { parseLocation } from "@/lib/stack/navigation";

export const dynamic = "force-dynamic";

type Params = { space?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { space } = await params;
  const segment = space?.[0];
  const title = spaceTitle(segment && isSpaceId(segment) ? segment : defaultSpace);
  return { title: `AgentStack · ${title}` };
}

export default async function Page({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { space } = await params;
  const segment = space?.[0];
  if (segment !== undefined && !isSpaceId(segment)) notFound();
  if (space && space.length > 1) notFound();
  const query = await searchParams;
  const { focus: focusParam } = query;
  const raw = Array.isArray(focusParam) ? focusParam[0] : focusParam;
  const initialFocus = raw ? parseNodeKey(raw) : null;
  const paramsQuery = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value[0] : value]]));
  const initialLocation = parseLocation(`/x/${segment ?? defaultSpace}`, paramsQuery)!;
  const incoming = await headers();
  const remote = incoming.get("x-agentstack-remote-uix") === "1" ? incoming.get("x-agentstack-uix-origin") : null;
  const scope = incoming.get("x-agentstack-uix-scope");
  return <Workbench snapshot={await loadSnapshot(remote ?? undefined, scope === "view" || scope === "control" ? scope : undefined,
    incoming.get("x-agentstack-uix-scopes")?.split(",").filter(Boolean) ?? [])} initialSpace={segment ?? defaultSpace} initialFocus={initialFocus} initialLocation={initialLocation} />;
}
