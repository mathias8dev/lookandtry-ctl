import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cliCommand, cliPrefix } from "./cli-helper.mjs";
import { fixture } from "./fixture.mjs";
import { loadSession, saveSession, apiOrigin, contextSchema } from "../dist/session.js";
import { LookClient } from "../dist/http.js";
import { OperationCatalog, execute } from "../dist/operations.js";
const run = promisify(execFile);
const cli = (f, ...args) => run(cliCommand, [...cliPrefix, ...args], { env: f.env });

test("discovery retains API contracts, inherited parameters and enum references, and hides auth/vault routes", async t => {
  const f = await fixture(t); await f.save(); const client = new LookClient(f.path);
  const catalog = await OperationCatalog.load(client);
  assert.equal(catalog.search("", 0, 2).operations.length, 2);
  assert.equal(catalog.search("", 0, 2).total, 7);
  assert.throws(() => catalog.operation("privateVault"), /Unknown operation/);
  assert.throws(() => catalog.operation("login"), /Unknown operation/);
  assert.deepEqual(catalog.schema("getProduct").components.schemas.Status.enum, ["ACTIVE", "ARCHIVED"]);
  assert.throws(() => catalog.prepare({ operationId: "getProduct" }), /Missing path/);
  assert.throws(() => catalog.prepare({ operationId: "getProduct", path: { id: ".." } }), /Invalid path/);
  assert.equal(catalog.prepare({ operationId: "getProduct", path: { id: "%2e%2e" } }).path, "/api/products/%252e%252e");
  assert.throws(() => catalog.search("", -1, 2), /offset/);
  assert.throws(() => catalog.search("", 0, 101), /limit/);
  assert.throws(() => catalog.prepare({ operationId: "listProducts", query: { unknown: 2 } }), /Unknown query/);
  assert.equal(catalog.prepare({ operationId: "listProducts", query: { page: 0, size: 20, sort: ["name,asc", "id,desc"] } }).path,
    "/api/products?page=0&size=20&sort=name%2Casc&sort=id%2Cdesc");
  await execute(client, catalog, { operationId: "getProduct", path: { id: "9" } });
  assert.equal(f.state.requests.at(-1).path, "/api/products/9");
  assert.equal(f.state.requests.at(-1).headers.authorization, "Bearer access-token");
});

test("execution cannot replace identity, organization or credential headers; backend denials propagate without retry", async t => {
  const f = await fixture(t); await f.save(); const client = new LookClient(f.path); const catalog = await OperationCatalog.load(client);
  for (const header of ["Authorization", "X-Identity-Context", "X-Organization-Id", "Cookie", "X-API-Key"]) {
    assert.throws(() => catalog.prepare({ operationId: "getProduct", path: { id: "9" }, headers: { [header]: "other" } }), /not an operation parameter/);
  }
  f.state.failWrite = true;
  await assert.rejects(execute(client, catalog, { operationId: "createProduct", body: { name: "product" } }), error => error.status === 503);
  assert.equal(f.state.requests.filter(r => r.path === "/api/products").length, 1);
  f.state.failWrite = false; f.state.scopeDenied = true;
  await assert.rejects(execute(client, catalog, { operationId: "getProduct", path: { id: "9" } }), error => error.status === 403);
  await assert.rejects(client.request("https://elsewhere.example/api/products"), /this LookAndTry API/);
});

test("CLI dry-run has no business write; downloads remain private and are never overwritten", async t => {
  const f = await fixture(t); await f.save(); const input = join(f.directory, "input.json");
  await writeFile(input, JSON.stringify({ body: { name: "Draft" } }));
  const dry = await cli(f, "execute", "createProduct", "--input", input, "--dry-run");
  assert.deepEqual(JSON.parse(dry.stdout).context, f.session.context);
  assert.equal(f.state.requests.some(r => r.path === "/api/products"), false);
  assert.equal(dry.stdout.includes("access-token"), false);
  const output = join(f.directory, "private.png"); await cli(f, "execute", "download", "--output", output);
  assert.deepEqual(await readFile(output), Buffer.from([0,1,255]));
  if (process.platform !== "win32") assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await assert.rejects(cli(f, "execute", "download", "--output", output));
  await assert.rejects(cli(f, "status", "--input", input), /not valid for status/);
});

test("binary and multipart requests preserve file bytes and generated boundaries through CLI and shared executor", async t => {
  const f = await fixture(t); await f.save(); const client = new LookClient(f.path); const catalog = await OperationCatalog.load(client);
  await execute(client, catalog, { operationId: "upload", rawBodyBase64: "AAH/", contentType: "application/octet-stream" });
  assert.deepEqual(f.state.requests.at(-1).body, Buffer.from([0,1,255]));
  const photo = join(f.directory, "photo.png"); await writeFile(photo, Buffer.from([0,1,255]));
  const result = await cli(f, "execute", "tryOn", "--file", `userPhoto=${photo};type=image/png`, "--field", "items=[]");
  assert.match(JSON.parse(result.stdout).body.contentType, /^multipart\/form-data; boundary=/);
  const body = f.state.requests.at(-1).body;
  assert.ok(body.includes(Buffer.from([0,1,255]))); assert.match(body.toString(), /name="userPhoto"; filename="photo.png"/);
  assert.match(body.toString(), /Content-Type: image\/png/); assert.match(body.toString(), /name="items"/);
  assert.throws(() => catalog.prepare({ operationId: "tryOn", body: {}, multipart: {} }), /Choose/);
});

test("private sessions reject symlinks, insecure modes, invalid contexts and origin drift", async t => {
  const f = await fixture(t); await f.save();
  assert.throws(() => apiOrigin("http://api.example.com"), /HTTPS/);
  assert.throws(() => apiOrigin("https://user:password@api.example.com"), /HTTPS/);
  assert.throws(() => contextSchema.parse({ contextType: "CONSUMER", organizationId: 7 }));
  assert.throws(() => contextSchema.parse({ contextType: "PLATFORM", organizationId: null }));
  if (process.platform !== "win32") {
    assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
    await chmod(f.path, 0o644); await assert.rejects(loadSession(f.path), /private/); await chmod(f.path, 0o600);
    const alias = join(f.directory, "alias.json"); await symlink(f.path, alias); await assert.rejects(loadSession(alias), /symlink/);
  }
  await assert.rejects(saveSession({ ...f.session, tokenEndpoint: "https://evil.example/token" }, join(f.directory, "bad.json")), /Identity origin/);
  const client = new LookClient(f.path); await client.session();
  await saveSession({ ...f.session, context: { contextType: "ORGANIZATION", organizationId: 8 } }, f.path, true);
  await assert.rejects(client.session(), /context or instance changed/);
});

test("refresh rotation is serialized, persisted, never retried and logout preserves failed revocation", async t => {
  const f = await fixture(t); f.session.expiresAt = new Date(Date.now()-1000).toISOString(); await f.save(); const client = new LookClient(f.path);
  await client.status(); assert.equal(f.state.refreshes, 1); assert.equal((await loadSession(f.path)).refreshToken, "rotated-refresh-token");
  await client.status(); assert.equal(f.state.refreshes, 1);
  f.state.failRevocation = true; await assert.rejects(client.logout(), /retained/); assert.ok(await readFile(f.path));
  f.state.failRevocation = false; await client.logout(); await assert.rejects(readFile(f.path), /ENOENT/);
  assert.equal(f.state.revocations.at(-1).get("token"), "rotated-refresh-token");
});

test("refresh lock excludes competing clients and rejected grants do not leak provider response data", async t => {
  const f = await fixture(t); f.session.expiresAt = new Date(Date.now()-1000).toISOString(); await f.save(); const client = new LookClient(f.path);
  await writeFile(`${f.path}.lock`, ""); await assert.rejects(client.status(), /Another lookctl process/); assert.equal(f.state.refreshes, 0);
  await rm(`${f.path}.lock`); f.state.rejectGrant = true;
  await assert.rejects(cli(f, "status"), error => { assert.equal(error.stderr.includes("must-not-be-printed"), false); return true; });
  assert.equal(f.state.refreshes, 1); await assert.rejects(lstat(`${f.path}.lock`), /ENOENT/);
});

async function beginLogin(t, f, selectors = ["--context", "ORGANIZATION"], interactive = false) {
  const args = [...cliPrefix, "login", "--api-url", f.origin, ...selectors, "--no-browser"];
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const child = interactive ? spawn("script", ["-q", "-e", "-c", [cliCommand, ...args].map(quote).join(" "), "/dev/null"], { env: f.env }) : spawn(cliCommand, args, { env: f.env });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const finished = once(child, "exit"); let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  let authorization;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No authorization URL: ${stderr}`)), 10000);
    const inspect = chunk => { stderr += chunk; const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?[^\s]+/);
      if (match) { authorization = new URL(match[0]); clearTimeout(timeout); resolve(); } };
    child.stderr.on("data", inspect); if (interactive) child.stdout.on("data", inspect);
    child.on("exit", () => { if (!authorization) { clearTimeout(timeout); reject(new Error(stderr)); } });
  });
  return { child, finished, authorization, output: () => stdout, errors: () => stderr };
}

test("browser login validates state, binds loopback and exchanges an S256 proof before live context verification", async t => {
  const f = await fixture(t); const flow = await beginLogin(t, f); const auth = flow.authorization;
  assert.equal(auth.searchParams.get("client_id"), "lookctl"); assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.has("resource"), false);
  const callback = new URL(auth.searchParams.get("redirect_uri")); assert.equal(callback.hostname, "127.0.0.1");
  callback.search = new URLSearchParams({ code: "code", state: "wrong", iss: f.origin }).toString();
  assert.equal((await fetch(callback)).status, 400); assert.equal(f.state.requests.some(r => r.path === "/oauth2/token"), false);
  callback.search = new URLSearchParams({ code: "code", state: auth.searchParams.get("state"), iss: "https://other.example" }).toString();
  assert.equal((await fetch(callback)).status, 400);
  callback.searchParams.set("iss", f.origin); assert.equal((await fetch(callback)).status, 200);
  assert.equal((await flow.finished)[0], 0, flow.errors());
  assert.equal(createHash("sha256").update(f.state.lastTokenForm.get("code_verifier")).digest("base64url"), auth.searchParams.get("code_challenge"));
  assert.equal((await loadSession(f.path)).identityId, 42);
  assert.equal(flow.output().includes("access-token"), false); assert.equal(flow.output().includes("rotated-refresh-token"), false);
});

test("denied context revokes the newly issued grant and creates no local session", async t => {
  const f = await fixture(t); f.state.denySelectedContext = true; const flow = await beginLogin(t, f);
  const callback = new URL(flow.authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ code: "code", state: flow.authorization.searchParams.get("state"), iss: f.origin }).toString();
  await fetch(callback); assert.equal((await flow.finished)[0], 1);
  assert.equal(f.state.revocations.length, 1); await assert.rejects(lstat(f.path), /ENOENT/);
});

test("browser cancellation does not request tokens or create a local session", async t => {
  const f = await fixture(t); const flow = await beginLogin(t, f);
  const callback = new URL(flow.authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ error: "access_denied", state: flow.authorization.searchParams.get("state"), iss: f.origin }).toString();
  await fetch(callback); assert.equal((await flow.finished)[0], 1); assert.match(flow.errors(), /declined/);
  assert.equal(f.state.requests.some(r => r.path === "/oauth2/token"), false);
});

test("official MCP SDK connects to stdio, discovers four tools and receives scoped results and structured failures", async t => {
  const f = await fixture(t); await f.save();
  const transport = new StdioClientTransport({ command: cliCommand, args: [...cliPrefix, "mcp"], env: f.env, stderr: "pipe" });
  const client = new Client({ name: "look-test", version: "1.0.0" }); t.after(() => client.close()); await client.connect(transport);
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 4);
  assert.equal(tools.find(tool => tool.name === "look_execute").annotations.destructiveHint, true);
  const status = await client.callTool({ name: "look_status", arguments: {} });
  assert.deepEqual(JSON.parse(status.content[0].text).context, f.session.context); assert.equal(JSON.stringify(status).includes("access-token"), false);
  const search = await client.callTool({ name: "look_search_operations", arguments: { query: "products", limit: 2 } });
  assert.equal(JSON.parse(search.content[0].text).operations.length, 2);
  const schema = await client.callTool({ name: "look_operation_schema", arguments: { operationId: "getProduct" } });
  assert.deepEqual(JSON.parse(schema.content[0].text).components.schemas.Status.enum, ["ACTIVE", "ARCHIVED"]);
  f.state.failWrite = true;
  const denied = await client.callTool({ name: "look_execute", arguments: { operationId: "createProduct", body: {} } });
  assert.equal(denied.isError, true); assert.equal(JSON.parse(denied.content[0].text).status, 503);
  assert.equal(f.state.requests.filter(r => r.path === "/api/products").length, 1);
});

test("consumer and platform contexts retain their exact header semantics and live permissions", async t => {
  for (const context of [{ contextType: "CONSUMER", organizationId: null }, { contextType: "PLATFORM", organizationId: 1 }]) {
    const f = await fixture(t); f.session.context = context; f.state.me.currentContext = { ...context, roles: ["existing-role"], permissions: ["existing:permission"] }; await f.save();
    const current = JSON.parse((await cli(f, "status")).stdout);
    assert.deepEqual(current.context, context); assert.deepEqual(current.account.currentContext.permissions, ["existing:permission"]);
    assert.equal(f.state.requests.at(-1).headers["x-organization-id"], context.organizationId === null ? undefined : "1");
  }
});

test("authenticated requests refuse redirects before forwarding credentials to another API instance", async t => {
  const f = await fixture(t); const other = await fixture(t); await f.save();
  const client = new LookClient(f.path); const catalog = await OperationCatalog.load(client);
  f.state.redirect = `${other.origin}/api/products`;
  await assert.rejects(execute(client, catalog, { operationId: "createProduct", body: {} }));
  assert.equal(other.state.requests.length, 0);
  assert.equal(f.state.requests.filter(r => r.path === "/api/products").length, 1);
});

test("request cancellation reaches the HTTP transport without retrying the business operation", async t => {
  const f = await fixture(t); await f.save(); let requests = 0;
  const client = new LookClient(f.path, async (_url, init) => {
    requests++;
    await new Promise((resolve, reject) => {
      if (init.signal.aborted) return reject(init.signal.reason);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
    throw new Error("Unreachable");
  });
  const abort = new AbortController();
  const response = client.request("/api/products", { method: "POST", signal: abort.signal });
  abort.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(response, error => error.name === "AbortError"); assert.equal(requests, 1);
});

async function finishBrowserLogin(flow, origin) {
  const callback = new URL(flow.authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ code: "code", state: flow.authorization.searchParams.get("state"), iss: origin }).toString();
  assert.equal((await fetch(callback)).status, 200);
}

function waitForPrompt(flow) {
  return new Promise((resolve, reject) => {
    const check = () => { if (flow.output().includes("Numéro du contexte")) { cleanup(); resolve(); } };
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`No context prompt: ${flow.errors()}`)); }, 10000);
    const cleanup = () => { clearTimeout(timeout); flow.child.stdout.removeListener("data", check); };
    flow.child.stdout.on("data", check); check();
  });
}

test("login needs only the API URL, discovers the registration and automatically selects a sole personal context", async t => {
  const f = await fixture(t); f.state.availableContexts = [];
  const flow = await beginLogin(t, f, []); await finishBrowserLogin(flow, f.origin);
  assert.equal((await flow.finished)[0], 0, flow.errors());
  assert.deepEqual((await loadSession(f.path)).context, { contextType: "CONSUMER", organizationId: null });
  assert.equal(f.state.requests[0].path, "/api/auth/native/config");
  assert.equal(f.state.lastTokenForm.has("resource"), false);
});

test("platform login resolves the system organization without requiring its ID", async t => {
  const f = await fixture(t); f.state.me.currentContext = { contextType: "PLATFORM", organizationId: 81 };
  const flow = await beginLogin(t, f, ["--context", "PLATFORM"]); await finishBrowserLogin(flow, f.origin);
  assert.equal((await flow.finished)[0], 0, flow.errors());
  assert.deepEqual((await loadSession(f.path)).context, { contextType: "PLATFORM", organizationId: 81 });
  const verification = f.state.requests.filter(r => r.path === "/api/auth/me");
  assert.equal(verification[0].headers["x-identity-context"], "CONSUMER");
  assert.equal(verification.at(-1).headers["x-organization-id"], "81");
});

test("noninteractive login refuses to guess between contexts and revokes its unused grant", async t => {
  const f = await fixture(t); const flow = await beginLogin(t, f, []); await finishBrowserLogin(flow, f.origin);
  assert.equal((await flow.finished)[0], 1); assert.match(flow.errors(), /Several contexts are available/);
  assert.equal(f.state.revocations.length, 1); await assert.rejects(lstat(f.path), /ENOENT/);
});

test("a requested context must be offered by the backend", async t => {
  const f = await fixture(t); const flow = await beginLogin(t, f, ["--context", "PLATFORM"]); await finishBrowserLogin(flow, f.origin);
  assert.equal((await flow.finished)[0], 1); assert.match(flow.errors(), /No accessible context/);
  assert.equal(f.state.revocations.length, 1);
  assert.equal(f.state.requests.filter(r => r.path === "/api/auth/me").length, 1);
});

test("interactive login lists named contexts and saves the chosen platform session", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t); f.state.availableContexts = [
    { contextType: "ORGANIZATION", organizationId: 7, organizationName: "Boutique Paris" },
    { contextType: "PLATFORM", organizationId: 81, organizationName: "LookAndTry Platform" },
  ]; f.state.me.currentContext = { contextType: "PLATFORM", organizationId: 81 };
  const flow = await beginLogin(t, f, [], true); await finishBrowserLogin(flow, f.origin); await waitForPrompt(flow);
  assert.match(flow.output(), /1\. Personnel/); assert.match(flow.output(), /2\. Organisation Boutique Paris/);
  assert.match(flow.output(), /3\. Administration plateforme/);
  flow.child.stdin.write("3\n"); assert.equal((await flow.finished)[0], 0, flow.errors());
  assert.deepEqual((await loadSession(f.path)).context, { contextType: "PLATFORM", organizationId: 81 });
  assert.equal(flow.output().includes("access-token"), false);
});

test("cancelling the context menu revokes the grant and creates no session", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t); const flow = await beginLogin(t, f, [], true);
  await finishBrowserLogin(flow, f.origin); await waitForPrompt(flow); flow.child.stdin.write("\u0003");
  assert.equal((await flow.finished)[0], 1); assert.equal(f.state.revocations.length, 1);
  await assert.rejects(lstat(f.path), /ENOENT/);
});

test("missing native configuration is actionable and performs no authentication request", async t => {
  const f = await fixture(t); f.state.configurationStatus = 404;
  await assert.rejects(cli(f, "login", "--api-url", f.origin, "--no-browser"), error => {
    assert.match(error.stderr, /update\/restart/); return true;
  });
  assert.deepEqual(f.state.requests.map(r => r.path), ["/api/auth/native/config"]);
});


test("existing sessions retain an explicitly requested resource when refreshing", async t => {
  const f = await fixture(t); f.session.resource = `${f.origin}/`; f.session.expiresAt = new Date(Date.now()-1000).toISOString(); await f.save();
  await new LookClient(f.path).status();
  assert.equal(f.state.lastTokenForm.get("resource"), `${f.origin}/`);
});
