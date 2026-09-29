import { localBrowserResponse } from "@stack/api";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => localBrowserResponse(request, process.env, "ui");
export const POST = GET;
