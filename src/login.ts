import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { apiOrigin, ContextType, issuerUrl, saveSession, sessionPath, type Session } from "./session.js";
import { discover, tokenRequest } from "./oauth.js";
import { account } from "./http.js";
import { fetchResponse, jsonResponse } from "./transport.js";
import { contextOptions, selectContext, type ContextSelector } from "./contexts.js";

const configurationSchema = z.object({ issuer: z.string(), clientId: z.literal("lookctl"), scopes: z.array(z.string().min(1)).min(1) }).strict();
export type LoginOptions = { apiUrl: string; noBrowser?: boolean } & ContextSelector;
export async function login(options: LoginOptions, path = sessionPath()): Promise<unknown> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new Error("A session already exists; logout first or choose another LOOKCTL_SESSION_FILE");
  const apiUrl = apiOrigin(options.apiUrl);
  const response = await fetchResponse(new URL("/api/auth/native/config", apiUrl), {
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    throw new Error("This backend does not expose the LookAndTry CLI configuration; update/restart it before running lookctl login");
  }
  const configuration = configurationSchema.parse(await jsonResponse(response));
  const issuer = issuerUrl(configuration.issuer);
  const clientId = configuration.clientId;
  const metadata = await discover(issuer);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  let redirectUri = "";
  let resolveCode!: (value: string) => void;
  let rejectCode!: (error: Error) => void;
  const received = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The callback may arrive before the caller awaits it (or server startup may fail).
  void received.catch(() => {});
  let completed = false;
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", redirectUri);
    const actualState = callback.searchParams.get("state") ?? "";
    const stateBytes = Buffer.from(actualState);
    const validState = stateBytes.length === state.length && timingSafeEqual(Buffer.from(state), stateBytes);
    const parameters = callback.searchParams;
    const error = parameters.get("error");
    const code = parameters.get("code");
    if (completed || request.method !== "GET" || request.headers.host !== new URL(redirectUri).host || callback.origin !== new URL(redirectUri).origin ||
        callback.pathname !== "/oauth2/callback" || !validState || parameters.getAll("state").length !== 1 ||
        parameters.getAll("iss").length > 1 || parameters.has("iss") && parameters.get("iss") !== issuer ||
        parameters.getAll("code").length > 1 || parameters.getAll("error").length > 1 ||
        !((code && /^[A-Za-z0-9._~-]{1,2048}$/.test(code) && !error) || (error && !code))) {
      response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Invalid LookAndTry CLI callback."); return;
    }
    completed = true;
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
    response.end(error ? "LookAndTry CLI authorization was declined." : "LookAndTry CLI authorization received. You can close this tab.");
    if (error) rejectCode(new Error("Browser authorization was declined or failed"));
    else resolveCode(code!);
  });
  const cancellation = new AbortController();
  const cancel = (error: Error) => { cancellation.abort(error); rejectCode(error); };
  const timeout = setTimeout(() => cancel(new Error("Login timed out after five minutes")), 300_000);
  const abort = () => cancel(new Error("Login cancelled"));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot bind loopback callback");
    redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri,
      scope: configuration.scopes.join(" "),
      code_challenge: codeChallenge, code_challenge_method: "S256", state, nonce: randomBytes(32).toString("base64url"),
    }).toString();
    process.stderr.write(`Open this URL to authorize LookAndTry CLI for ${apiUrl}:\n${authorization}\n`);
    if (!options.noBrowser) {
      const [command, ...args] = process.platform === "darwin" ? ["open", authorization.href] :
        process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", authorization.href] : ["xdg-open", authorization.href];
      const browser = spawn(command!, args, { stdio: "ignore", detached: true });
      browser.on("error", () => process.stderr.write("Open the authorization URL above in your browser.\n")); browser.unref();
    }
    const code = await received;
    const tokens = await tokenRequest(metadata.token_endpoint, { grant_type: "authorization_code", client_id: clientId,
      code, redirect_uri: redirectUri, code_verifier: verifier });
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const authenticated = { apiUrl, accessToken: tokens.access_token };
    try {
      // The resource server authenticates the token and resolves live membership/permissions.
      // No account is selected using an email or unverified JWT claims.
      const personal = await account({ ...authenticated, context: { contextType: ContextType.CONSUMER, organizationId: null } });
      const context = await selectContext(contextOptions(personal), {
        ...(options.contextType === undefined ? {} : { contextType: options.contextType }),
        ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
      }, undefined, cancellation.signal);
      cancellation.signal.throwIfAborted();
      const current = await account({ ...authenticated, context });
      if (current.identity.id !== personal.identity.id) throw new Error("LookAndTry account changed during context selection");
      const session: Session = {
        ...authenticated, context, issuer, clientId, tokenEndpoint: metadata.token_endpoint, revocationEndpoint: metadata.revocation_endpoint,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        identityId: current.identity.id, email: current.identity.email,
        expiresAt,
      };
      await saveSession(session, path);
      return { apiUrl, issuer, context, identityId: session.identityId, email: session.email, expiresAt: session.expiresAt };
    } catch (failure) {
      // Do not leave a newly issued grant active if the context or local save was rejected.
      const { oauthForm } = await import("./oauth.js");
      const response = await oauthForm(metadata.revocation_endpoint, { client_id: clientId, token: tokens.refresh_token ?? tokens.access_token });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Login failed and Identity revocation failed (HTTP ${response.status}); revoke the lookctl session in Identity`, { cause: failure });
      throw failure;
    }
  } finally {
    clearTimeout(timeout); process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    server.closeAllConnections(); server.close();
  }
}
