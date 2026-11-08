import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveSession } from "../dist/session.js";
export const catalog = { openapi: "3.0.1", paths: {
  "/api/products/{id}": { parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
    get: { operationId: "getProduct", tags: ["products"], responses: { 200: { description: "product", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
    delete: { operationId: "deleteProduct", parameters: [{ name: "id", in: "path", required: true }] } },
  "/api/products": { get: { operationId: "listProducts", parameters: [{ name: "page", in: "query" }, { name: "size", in: "query" }, { name: "sort", in: "query" }] },
    post: { operationId: "createProduct", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } } } },
  "/api/download": { get: { operationId: "download" } },
  "/api/upload": { post: { operationId: "upload", requestBody: { required: true, content: { "application/octet-stream": {} } } } },
  "/api/try-on": { post: { operationId: "tryOn", requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object" } } } } } },
  "/api/internal/web-sessions": { get: { operationId: "privateVault" } },
  "/api/auth/login": { post: { operationId: "login" } },
}, components: { schemas: { Product: { type: "object", properties: { status: { $ref: "#/components/schemas/Status" } } }, Status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] } } } };

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lookctl-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { requests: [], revocations: [], refreshes: 0, failRevocation: false, failWrite: false, scopeDenied: false,
    me: { identity: { id: 42, email: "person@example.com" }, currentContext: { contextType: "ORGANIZATION", organizationId: 7 } } };
  let origin;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url, origin);
    state.requests.push({ path: url.pathname, url: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    const send = (status, value) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/auth/native/config") return send(state.configurationStatus ?? 200, state.configuration ?? { issuer: origin, clientId: "lookctl", scopes: ["openid", "email", "offline_access", "lookandtry.api"] });
    if (url.pathname === "/.well-known/openid-configuration") return send(200, { issuer: origin,
      authorization_endpoint: `${origin}/oauth2/authorize`, token_endpoint: `${origin}/oauth2/token`, revocation_endpoint: `${origin}/oauth2/revoke`, code_challenge_methods_supported: ["S256"] });
    if (url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(body.toString());
      if (form.get("grant_type") === "refresh_token") state.refreshes++;
      if (state.rejectGrant) return send(400, { error: "invalid_grant", confidential: "must-not-be-printed" });
      state.lastTokenForm = form;
      return send(200, { access_token: "access-token", refresh_token: "rotated-refresh-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/oauth2/revoke") { state.revocations.push(new URLSearchParams(body.toString())); return send(state.failRevocation ? 503 : 200, {}); }
    if (request.headers.authorization !== "Bearer access-token") return send(401, { error: "unauthorized" });
    if (url.pathname === "/api/auth/me" && request.headers["x-identity-context"] === "CONSUMER" && request.headers["x-organization-id"] === undefined && !state.scopeDenied) {
      return send(200, { ...state.me, currentContext: state.me.currentContext.contextType === "CONSUMER" ? state.me.currentContext : { contextType: "CONSUMER", organizationId: null },
        availableContexts: state.availableContexts ?? [state.me.currentContext] });
    }
    if (request.headers["x-identity-context"] !== state.me.currentContext.contextType || request.headers["x-organization-id"] !== (state.me.currentContext.organizationId === null ? undefined : String(state.me.currentContext.organizationId)) || state.scopeDenied) return send(403, { error: "forbidden" });
    if (url.pathname === "/api/auth/me") return send(state.denySelectedContext ? 403 : 200, { ...state.me, availableContexts: state.availableContexts ?? [state.me.currentContext] });
    if (url.pathname === "/v3/api-docs") return send(200, catalog);
    if (url.pathname === "/api/download") { response.setHeader("Content-Type", "image/png"); response.end(Buffer.from([0, 1, 255])); return; }
    if (state.redirect) { response.writeHead(307, { Location: state.redirect }); response.end(); return; }
    if (state.failWrite) return send(503, { error: "unavailable" });
    if (url.pathname === "/api/upload" || url.pathname === "/api/try-on") return send(200, { bytes: body.length, contentType: request.headers["content-type"] });
    return send(200, { id: 9 });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const path = join(directory, "session.json");
  const session = { apiUrl: origin, issuer: origin, clientId: "lookctl", tokenEndpoint: `${origin}/oauth2/token`, revocationEndpoint: `${origin}/oauth2/revoke`,
    accessToken: "access-token", refreshToken: "refresh-token", identityId: 42, email: "person@example.com", context: { contextType: "ORGANIZATION", organizationId: 7 }, expiresAt: new Date(Date.now()+3600000).toISOString() };
  const env = { ...process.env, LOOKCTL_SESSION_FILE: path }; delete env.LOOKCTL_API_URL;
  return { directory, path, session, state, origin, env, save: () => saveSession(session, path) };
}
