import { z } from "zod";
import { LookClient, ApiError, jsonResponse, readBounded } from "./http.js";

export enum HttpMethod { GET = "get", POST = "post", PUT = "put", PATCH = "patch", DELETE = "delete", HEAD = "head", OPTIONS = "options" }
export enum ParameterLocation { PATH = "path", QUERY = "query", HEADER = "header", COOKIE = "cookie" }
enum ParameterStyle { MATRIX = "matrix", LABEL = "label", FORM = "form", SIMPLE = "simple", SPACE_DELIMITED = "spaceDelimited", PIPE_DELIMITED = "pipeDelimited", DEEP_OBJECT = "deepObject" }
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const base64Schema = z.string().max(90 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const parameterSchema = z.object({
  name: z.string(), in: z.enum(ParameterLocation), required: z.boolean().optional(),
  schema: z.record(z.string(), z.unknown()).optional(), style: z.enum(ParameterStyle).optional(), explode: z.boolean().optional(),
}).passthrough();
const operationSchema = z.object({
  operationId: z.string(), summary: z.string().optional(), description: z.string().optional(),
  tags: z.array(z.string()).optional(), parameters: z.array(parameterSchema).optional(),
  requestBody: z.object({ required: z.boolean().optional(), content: z.record(z.string(), z.unknown()) }).optional(),
}).passthrough();
const documentSchema = z.object({
  openapi: z.string(), paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.record(z.string(), z.unknown()).optional(),
});
export type Operation = z.infer<typeof operationSchema> & { path: string; method: HttpMethod };
export const executionSchema = z.object({
  operationId: z.string().min(1),
  path: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional(),
  headers: z.record(z.string(), z.string()).optional(), body: z.unknown().optional(),
  contentType: z.string().optional(),
  rawBodyBase64: base64Schema.optional(),
  multipart: z.object({
    fields: z.record(z.string().min(1), z.string()).optional(),
    files: z.array(z.object({ name: z.string().min(1), filename: z.string().min(1), contentType: z.string().default("application/octet-stream"), dataBase64: base64Schema }).strict()).max(50).optional(),
  }).strict().optional(),
}).strict();
export type Execution = z.infer<typeof executionSchema>;
const credentialHeaders = new Set(["authorization", "cookie", "host", "x-identity-context", "x-organization-id", "x-api-key", "set-cookie"]);

export class OperationCatalog {
  private constructor(readonly operations: Operation[], private readonly document: z.infer<typeof documentSchema>) {}

  static async load(client: LookClient): Promise<OperationCatalog> {
    // The schema has no user data but may be larger than ordinary paginated API responses.
    const response = await client.request("/v3/api-docs");
    if (!response.ok) await jsonResponse(response);
    const document = documentSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(response, 16 * 1024 * 1024))));
    const operations: Operation[] = [];
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      if (!path.startsWith("/api/") || path.startsWith("/api/internal/") || path === "/api/auth" || path.startsWith("/api/auth/")) continue;
      for (const method of Object.values(HttpMethod)) {
        if (!item[method]) continue;
        const raw = item[method] as Record<string, unknown>;
        const resolve = (value: unknown): unknown => {
          const reference = value && typeof value === "object" ? (value as Record<string, unknown>).$ref : undefined;
          if (typeof reference !== "string") return value;
          const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(reference);
          const section = match ? document.components?.[match[1]!] as Record<string, unknown> | undefined : undefined;
          if (!match || !section?.[match[2]!]) throw new Error(`Unsupported or missing OpenAPI reference ${reference}`);
          return section[match[2]!];
        };
        const inherited = Array.isArray(item.parameters) ? item.parameters.map(value => parameterSchema.parse(resolve(value))) : [];
        const own = Array.isArray(raw.parameters) ? raw.parameters.map(value => parameterSchema.parse(resolve(value))) : [];
        const parameters = [...inherited.filter(p => !own.some(o => o.name === p.name && o.in === p.in)), ...own];
        const operation = operationSchema.parse({ ...raw, parameters, ...(raw.requestBody ? { requestBody: resolve(raw.requestBody) } : {}) });
        if (ids.has(operation.operationId)) throw new Error(`Duplicate OpenAPI operation ID: ${operation.operationId}`);
        ids.add(operation.operationId);
        operations.push({ ...operation, method, path });
      }
    }
    if (!operations.length) throw new Error("LookAndTry returned an empty API operation catalog");
    return new OperationCatalog(operations.sort((a, b) => a.operationId.localeCompare(b.operationId)), document);
  }

  search(query = "", offset = 0, limit = 25): unknown {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use offset >= 0 and limit 1..100");
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const results = this.operations.filter(operation => {
      const haystack = [operation.operationId, operation.path, operation.summary, operation.description, ...(operation.tags ?? [])].join(" ").toLowerCase();
      return words.every(word => haystack.includes(word));
    });
    return { total: results.length, offset, limit, operations: results.slice(offset, offset + limit).map(({ operationId, method, path, summary, tags }) => ({ operationId, method: method.toUpperCase(), path, summary, tags })) };
  }

  operation(id: string): Operation {
    const operation = this.operations.find(item => item.operationId === id);
    if (!operation) throw new Error(`Unknown operation ${id}; use lookctl operations to discover current operations`);
    return operation;
  }

  schema(id: string): unknown {
    const operation = this.operation(id);
    const components: Record<string, Record<string, unknown>> = {};
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === "string") {
        const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(object.$ref);
        if (!match) throw new Error(`Unsupported schema reference ${object.$ref}`);
        const group = match[1]!;
        const name = match[2]!;
        const section = this.document.components?.[group] as Record<string, unknown> | undefined;
        const referenced = section?.[name];
        if (!referenced) throw new Error(`Missing schema reference ${object.$ref}`);
        const included = components[group] ??= {};
        if (!(name in included)) { included[name] = referenced; visit(referenced); }
      }
      Object.values(object).forEach(visit);
    };
    visit(operation);
    return { ...operation, components };
  }

  prepare(value: Execution): { method: string; path: string; headers: Record<string, string>; body?: string | Uint8Array | FormData } {
    const input = executionSchema.parse(value);
    const operation = this.operation(input.operationId);
    let path = operation.path;
    const parameters = operation.parameters ?? [];
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.path ?? {})) {
      if (!parameters.some(p => p.in === ParameterLocation.PATH && p.name === name) || [".", ".."].includes(value)) throw new Error(`Invalid path parameter ${name}`);
      path = path.replaceAll(`{${name}}`, encodeURIComponent(value));
    }
    if (/\{[^}]+\}/.test(path)) throw new Error(`Missing path parameters for ${path}`);
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query ?? {})) {
      const parameter = parameters.find(p => p.in === ParameterLocation.QUERY && p.name === name);
      if (!parameter) throw new Error(`Unknown query parameter ${name}`);
      if (parameter.style && parameter.style !== ParameterStyle.FORM) throw new Error(`Unsupported query serialization ${parameter.style}`);
      if (Array.isArray(value)) {
        if (parameter.explode === false) query.append(name, value.join(","));
        else for (const item of value) query.append(name, String(item));
      } else query.append(name, String(value));
    }
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (credentialHeaders.has(name.toLowerCase()) || !parameters.some(p => p.in === ParameterLocation.HEADER && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`Header ${name} is not an operation parameter`);
      headers[name.toLowerCase()] = value;
    }
    for (const parameter of parameters.filter(p => p.required && !(p.in === ParameterLocation.HEADER && credentialHeaders.has(p.name.toLowerCase())))) {
      if (parameter.in === ParameterLocation.QUERY && !query.has(parameter.name)) throw new Error(`Required query parameter ${parameter.name}`);
      if (parameter.in === ParameterLocation.HEADER && !Object.keys(headers).some(name => name.toLowerCase() === parameter.name.toLowerCase())) throw new Error(`Required header ${parameter.name}`);
    }
    if (query.size) path += `?${query}`;
    if ([input.body, input.rawBodyBase64, input.multipart].filter(value => value !== undefined).length > 1) throw new Error("Choose body, rawBodyBase64 or multipart");
    let body: string | Uint8Array | FormData | undefined;
    if (input.multipart) {
      if (input.contentType || headers["content-type"]) throw new Error("Multipart content type and boundary are generated automatically");
      body = new FormData();
      let total = 0;
      for (const [name, value] of Object.entries(input.multipart.fields ?? {})) {
        total += Buffer.byteLength(value); body.append(name, value);
      }
      for (const file of input.multipart.files ?? []) {
        const bytes = Buffer.from(file.dataBase64, "base64"); total += bytes.length;
        if (total > MAX_UPLOAD_BYTES) throw new Error("Multipart request exceeds 64 MiB");
        body.append(file.name, new Blob([bytes], { type: file.contentType }), file.filename);
      }
      if (total > MAX_UPLOAD_BYTES) throw new Error("Multipart request exceeds 64 MiB");
    } else {
      body = input.rawBodyBase64 === undefined ? (input.body === undefined ? undefined : JSON.stringify(input.body)) : Buffer.from(input.rawBodyBase64, "base64");
      if (body instanceof Uint8Array && body.byteLength > MAX_UPLOAD_BYTES) throw new Error("Body exceeds 64 MiB");
      if (body !== undefined) headers["content-type"] = input.contentType ?? headers["content-type"] ?? (input.rawBodyBase64 === undefined ? "application/json" : "application/octet-stream");
    }
    if (operation.requestBody?.required && body === undefined) throw new Error("This operation requires a request body");
    if (body !== undefined && operation.requestBody) {
      const mime = body instanceof FormData ? "multipart/form-data" : headers["content-type"]!.split(";")[0]!.trim();
      const supported = Object.keys(operation.requestBody.content);
      if (!supported.some(type => type === mime || type === "*/*" || type.endsWith("/*") && mime.startsWith(type.slice(0,-1)))) {
        throw new Error(`Unsupported content type ${mime}; operation accepts ${supported.join(", ")}`);
      }
    }
    return { method: operation.method.toUpperCase(), path, headers, ...(body === undefined ? {} : { body }) };
  }
}

export async function execute(client: LookClient, catalog: OperationCatalog, input: Execution, signal?: AbortSignal): Promise<unknown> {
  const prepared = catalog.prepare(input);
  const response = await client.request(prepared.path, {
    method: prepared.method, headers: prepared.headers,
    ...(prepared.body === undefined ? {} : { body: prepared.body as BodyInit }),
    ...(signal ? { signal } : {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json") || contentType.startsWith("text/") || !response.ok || response.status === 204) {
    return { status: response.status, contentType, body: await jsonResponse(response) };
  }
  const bytes = await readBounded(response);
  if (!response.ok) throw new ApiError(response.status, "Binary error response");
  return { status: response.status, contentType, bodyBase64: Buffer.from(bytes).toString("base64") };
}
