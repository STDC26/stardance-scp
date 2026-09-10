// LAB-INFRA-01A — the Vercel transport adapter.
//
// Vercel invokes a request handler per request rather than supervising a
// long-lived `listen()`. This file is the whole of that difference: it hands
// Vercel the SAME handler that `src/server.ts` binds locally, so the Lab and a
// developer machine cannot diverge on routing.
//
// It is deliberately the thinnest file in the repository. Nothing may be added
// here that is not present in `handleLabsRequest` — no route table, no
// authentication, no configuration read, no database work. If a behaviour is
// worth having, it belongs behind the shared handler where the tests can see
// it, not in a platform adapter that only runs in one environment.
//
// `vercel.json` rewrites every path to this function, so `req.url` still
// carries the caller's original path and the shared handler does the routing.

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLabsRequest } from "../src/server";

export default function handler(req: IncomingMessage, res: ServerResponse): void {
    handleLabsRequest(req, res);
}
