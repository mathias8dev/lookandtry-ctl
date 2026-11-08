import { VERSION } from "./version.js";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { LookClient, errorDetails } from "./http.js";
import { OperationCatalog, execute, executionSchema } from "./operations.js";

export function createMcpServer(client = new LookClient()): McpServer {
  const server = new McpServer({ name: "lookandtry", version: VERSION }, {
    instructions: "Act as the signed-in LookAndTry user in their selected context. First inspect look_status, discover operations with look_search_operations and inspect their exact contracts with look_operation_schema. Use bounded search/pagination. Sending, publishing, deleting, billing and governance changes have real effects. Do not retry a write automatically after an uncertain result. Authentication is interactive outside MCP: run lookctl login in a terminal.",
  });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const guarded = async (work: () => Promise<unknown>) => {
    try { return result(await work()); }
    catch (error) {
      return { ...result(errorDetails(error)), isError: true };
    }
  };
  server.registerTool("look_status", {
    description: "Read current LookAndTry account and context. Never returns session tokens.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => guarded(async () => {
    return client.status();
  }));
  server.registerTool("look_search_operations", {
    description: "Discover current LookAndTry API operations by keywords in their names, routes and descriptions. Returns a bounded page; use offset to continue.",
    inputSchema: z.object({ query: z.string().default(""), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) }).strict(),
    annotations: { readOnlyHint: true },
  }, async ({ query, offset, limit }) => guarded(async () => (await OperationCatalog.load(client)).search(query, offset, limit)));
  server.registerTool("look_operation_schema", {
    description: "Read an operation's method, path/query/header parameters, request/response schemas and referenced enum/component definitions. Inspect before execute.",
    inputSchema: z.object({ operationId: z.string() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ operationId }) => guarded(async () => (await OperationCatalog.load(client)).schema(operationId)));
  server.registerTool("look_execute", {
    description: "Execute a discovered LookAndTry API operation as the user. Supply path/query/headers plus JSON body, rawBodyBase64 or multipart fields/files. Enforces current backend permissions and policies. Can publish/send/delete/change settings. Returns structured errors as isError; never retries writes. Binary responses are bounded base64; use CLI --output for larger downloads.",
    inputSchema: executionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (input, context) => guarded(async () => execute(client, await OperationCatalog.load(client), input, context.mcpReq.signal)));
  return server;
}

export function startMcp(): void {
  serveStdio(() => createMcpServer(), { onerror: error => process.stderr.write(`${error.message}\n`) });
}
