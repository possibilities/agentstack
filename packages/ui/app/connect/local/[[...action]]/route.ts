import { localBrowserResponse } from "@agentstack/api";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => localBrowserResponse(request, process.env, "ui");
export const POST = GET;
