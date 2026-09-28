import { NextResponse, type NextRequest } from "next/server";

/** The operator snapshot is private even before the WebSocket connects. */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) {
    return new NextResponse(null, { status: 403 });
  }
  return NextResponse.next();
}
