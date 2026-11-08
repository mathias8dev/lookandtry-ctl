#!/usr/bin/env node
import { VERSION } from "./version.js";
import { parseArgs } from "node:util";
import { open, rm } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LookClient, errorDetails, jsonResponse } from "./http.js";
import { login } from "./login.js";
import { ContextType } from "./session.js";
import { OperationCatalog, executionSchema, execute } from "./operations.js";

async function readInput(path: string): Promise<string> {
  if (path !== "-") {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("JSON input must be a regular file up to 2 MiB");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("JSON input exceeds 2 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

enum Command { LOGIN = "login", STATUS = "status", LOGOUT = "logout", OPERATIONS = "operations", SCHEMA = "schema", EXECUTE = "execute", MCP = "mcp", HELP = "help" }
const help = `Usage:
  lookctl login --api-url https://api.lookandtry.example [--no-browser]\n  lookctl login --api-url https://api.lookandtry.example --context PLATFORM
  lookctl status
  lookctl logout
  lookctl operations [keywords] [--offset 0] [--limit 25]
  lookctl schema OPERATION_ID
  lookctl execute OPERATION_ID --input request.json [--dry-run] [--output download.bin]
  lookctl execute OPERATION_ID --input - [--body-file upload.bin --content-type image/png]
  lookctl execute OPERATION_ID --file 'userPhoto=/path/photo.png;type=image/png' --field 'items=[]'\n  lookctl mcp
  lookctl --version

Input JSON: {"path":{},"query":{},"headers":{},"body":{}}
Use schema to inspect the current operation contract. --dry-run prepares the request without executing it.
--output creates a new private file; existing files are never overwritten.
LOOKCTL_API_URL supplies the login API origin. Identity configuration and available contexts are discovered automatically. LOOKCTL_SESSION_FILE selects an independent session.
All commands emit JSON to stdout; diagnostics and browser login URLs go to stderr.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "context": { type: "string" }, "organization-id": { type: "string" },
      "api-url": { type: "string" }, "no-browser": { type: "boolean" }, input: { type: "string" },
      "dry-run": { type: "boolean" }, output: { type: "string" }, "body-file": { type: "string" },
      file: { type: "string", multiple: true }, field: { type: "string", multiple: true },
      "content-type": { type: "string" }, offset: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  const [command, ...args] = positionals;
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const client = new LookClient();
  if (values.help || !command || command === Command.HELP) { process.stdout.write(help); return; }
  if (!Object.values(Command).includes(command as Command)) throw new Error(`Unknown command ${command}; use lookctl --help`);
  if (![Command.OPERATIONS, Command.SCHEMA, Command.EXECUTE].includes(command as Command) && args.length) throw new Error("Unexpected positional arguments");
  const allowedOptions: Record<Command, string[]> = {
    [Command.LOGIN]: ["api-url", "context", "organization-id", "no-browser"], [Command.STATUS]: [], [Command.LOGOUT]: [],
    [Command.OPERATIONS]: ["offset", "limit"], [Command.SCHEMA]: [],
    [Command.EXECUTE]: ["input", "dry-run", "output", "body-file", "content-type", "file", "field"], [Command.MCP]: [], [Command.HELP]: [],
  };
  for (const option of Object.keys(values)) {
    if (!allowedOptions[command as Command].includes(option)) throw new Error(`--${option} is not valid for ${command}`);
  }
  switch (command) {
    case Command.LOGIN: {
      const origin = values["api-url"] ?? process.env.LOOKCTL_API_URL;
      if (!origin) throw new Error("Specify --api-url or LOOKCTL_API_URL");
      const contextType = values.context;
      if (contextType !== undefined && !Object.values(ContextType).includes(contextType as ContextType)) throw new Error("--context must be CONSUMER, ORGANIZATION or PLATFORM");
      const organizationId = values["organization-id"] === undefined ? undefined : Number(values["organization-id"]);
      if (organizationId !== undefined && (!Number.isSafeInteger(organizationId) || organizationId < 1 || contextType === ContextType.CONSUMER)) throw new Error("--organization-id must be a positive integer for an organization or platform context");
      print(await login({ apiUrl: origin,
        ...(contextType === undefined ? {} : { contextType: contextType as ContextType }),
        ...(organizationId === undefined ? {} : { organizationId }),
        ...(values["no-browser"] ? { noBrowser: true } : {}),
      })); return;
    }
    case Command.MCP: {
      const { startMcp } = await import("./mcp.js"); startMcp(); return;
    }
    case Command.STATUS: {
      print(await client.status()); return;
    }
    case Command.LOGOUT: {
      await client.logout(); print({ loggedOut: true }); return;
    }
  }
  const catalog = await OperationCatalog.load(client);
  if (command === Command.OPERATIONS) { print(catalog.search(args.join(" "), Number(values.offset ?? 0), Number(values.limit ?? 25))); return; }
  if (args.length !== 1) throw new Error("Specify one operation ID");
  const operationId = args[0]!;
  if (command === Command.SCHEMA) { print(catalog.schema(operationId)); return; }
  const raw: unknown = values.input ? JSON.parse(await readInput(values.input)) : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "operationId" in raw) throw new Error("Input must be an object without operationId");
  const input = executionSchema.parse({ ...raw, operationId });
  if (values["body-file"]) {
    if (input.body !== undefined || input.rawBodyBase64 !== undefined) throw new Error("--body-file cannot be combined with an input body");
    const handle = await open(values["body-file"], "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Body file must be a regular file up to 64 MiB");
      input.rawBodyBase64 = (await handle.readFile()).toString("base64");
    } finally { await handle.close(); }
  }
  if (values.file || values.field) {
    if (input.body !== undefined || input.rawBodyBase64 !== undefined || input.multipart !== undefined) throw new Error("--file/--field cannot be combined with an input body or multipart");
    input.multipart = { fields: {}, files: [] };
    for (const field of values.field ?? []) {
      const separator = field.indexOf("=");
      if (separator < 1) throw new Error("--field must be name=value");
      input.multipart.fields![field.slice(0, separator)] = field.slice(separator + 1);
    }
    let total = 0;
    for (const file of values.file ?? []) {
      const match = /^([^=]+)=(.*?)(?:;type=([^;]+))?$/.exec(file);
      if (!match?.[2]) throw new Error("--file must be name=/path/file;type=image/png");
      const handle = await open(match[2], "r");
      try {
        const stat = await handle.stat(); total += stat.size;
        if (!stat.isFile() || total > 64 * 1024 * 1024) throw new Error("Upload files must be regular files totaling at most 64 MiB");
        input.multipart.files!.push({ name: match[1]!, filename: basename(match[2]), contentType: match[3] ?? "application/octet-stream", dataBase64: (await handle.readFile()).toString("base64") });
      } finally { await handle.close(); }
    }
  }
  if (values["content-type"]) input.contentType = values["content-type"];
  const prepared = catalog.prepare(input);
  if (values["dry-run"]) {
    const session = await client.session();
    print({ apiUrl: session.apiUrl, context: session.context, ...prepared,
      ...(prepared.body instanceof FormData ? { body: { multipart: [...prepared.body.entries()].map(([name, value]) => ({ name, ...(typeof value === "string" ? { value } : { filename: value.name, bytes: value.size, contentType: value.type }) })) } } :
        prepared.body instanceof Uint8Array ? { body: { bytes: prepared.body.byteLength } } : {}) }); return;
  }
  if (!values.output) { print(await execute(client, catalog, input)); return; }
  const file = await open(values.output, "wx", 0o600);
  let status: number;
  let contentType: string | null;
  try {
    const response = await client.request(prepared.path, { method: prepared.method, headers: prepared.headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body as BodyInit }) });
    if (!response.ok) await jsonResponse(response);
    status = response.status;
    contentType = response.headers.get("content-type");
    if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), file.createWriteStream({ autoClose: false }));
    await file.sync();
  } catch (error) { await rm(values.output, { force: true }); throw error; }
  finally { await file.close(); }
  print({ status, output: values.output, contentType });
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify(errorDetails(error))}\n`);
  process.exitCode = 1;
});
