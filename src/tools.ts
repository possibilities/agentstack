import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Supervisor, type ServerView } from "./supervisor.js";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const serverViewSchema = z.object({
  id: idSchema,
  pid: z.number().int().nullable(),
  cwd: z.string(),
  url: z.string().nullable(),
  state: z.enum(["running", "stopped"]),
});

export function registerTools(server: McpServer, supervisor: Supervisor): void {
  server.registerTool(
    "server_start",
    {
      description: "Start a Codex app-server websocket process, or return the live one with this id. Extra args are passed through. Do not pass --listen.",
      inputSchema: z.object({
        cwd: z.string(),
        id: idSchema.optional(),
        codexBin: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
      }),
      outputSchema: serverViewSchema,
    },
    async ({ cwd, id, codexBin, args }) => toolResult(await supervisor.start({ cwd, id, codexBin, args })),
  );

  server.registerTool(
    "server_stop",
    {
      description: "Stop a Codex app-server process. Stopping an already stopped server succeeds.",
      inputSchema: z.object({ id: idSchema }),
      outputSchema: serverViewSchema,
    },
    async ({ id }) => toolResult(await supervisor.stop(id)),
  );

  server.registerTool(
    "server_list",
    {
      description: "List Codex app-server processes this daemon has started, including ones that have stopped.",
      inputSchema: z.object({}),
      outputSchema: z.object({ servers: z.array(serverViewSchema) }),
    },
    async () => {
      const servers = supervisor.list();
      return {
        content: [{ type: "text", text: JSON.stringify({ servers }) }],
        structuredContent: { servers },
      };
    },
  );
}

function toolResult(server: ServerView) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(server) }],
    structuredContent: server,
  };
}
