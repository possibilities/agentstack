import { localBrowserResponse } from "@agentstack/api";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => localBrowserResponse(request, process.env, "uix");
export const POST = GET;
