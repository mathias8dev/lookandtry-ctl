import { rm } from "node:fs/promises";
import { z } from "zod";
import { VERSION } from "./version.js";
import { ContextType, loadSession, saveSession, sessionPath, withSessionLock, type Session } from "./session.js";
import { oauthForm, tokenRequest } from "./oauth.js";
import { fetchResponse, jsonResponse } from "./transport.js";
export { ApiError, errorDetails, jsonResponse, readBounded } from "./transport.js";

const accountSchema = z.object({
  identity: z.object({ id: z.number().int().positive().safe(), email: z.string() }).passthrough(),
  currentContext: z.object({ contextType: z.enum(ContextType), organizationId: z.number().int().positive().safe().nullable() }).passthrough(),
}).passthrough();

export async function account(session: Pick<Session, "apiUrl" | "accessToken" | "context">): Promise<z.infer<typeof accountSchema>> {
  const response = await fetchResponse(new URL("/api/auth/me", session.apiUrl), {
    headers: credentials(session), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const result = accountSchema.parse(await jsonResponse(response));
  if (result.currentContext.contextType !== session.context.contextType || result.currentContext.organizationId !== session.context.organizationId) {
    throw new Error("Backend returned a different identity context");
  }
  return result;
}

function credentials(session: Pick<Session, "accessToken" | "context">): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`, "X-Identity-Context": session.context.contextType,
    ...(session.context.organizationId === null ? {} : { "X-Organization-Id": String(session.context.organizationId) }),
    "User-Agent": `lookctl/${VERSION}`, Accept: "application/json",
  };
}

export class LookClient {
  private binding?: string;
  constructor(private readonly sessionFile = sessionPath(), private readonly fetcher: typeof fetch = fetch) {}

  async session(): Promise<Session> {
    const session = await loadSession(this.sessionFile);
    const binding = JSON.stringify([session.apiUrl, session.issuer, session.clientId, session.resource ?? null, session.identityId, session.context]);
    if (this.binding && this.binding !== binding) throw new Error("LookAndTry account, context or instance changed; restart this client and inspect look_status before acting");
    this.binding ??= binding;
    return session;
  }

  private async freshSession(): Promise<Session> {
    let session = await this.session();
    if (Date.parse(session.expiresAt) > Date.now() + 30_000) return session;
    // One process rotates this refresh token at a time. Never retry an uncertain rotation.
    return withSessionLock(this.sessionFile, async () => {
      session = await this.session();
      if (Date.parse(session.expiresAt) > Date.now() + 30_000) return session;
      if (!session.refreshToken) throw new Error("Session expired; run lookctl logout then lookctl login");
      const tokens = await tokenRequest(session.tokenEndpoint, {
        grant_type: "refresh_token", client_id: session.clientId, refresh_token: session.refreshToken,
        ...(session.resource === undefined ? {} : { resource: session.resource }),
      });
      const next: Session = { ...session, accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() };
      // Persist rotation before checking API availability; otherwise the only valid refresh token is lost.
      await saveSession(next, this.sessionFile, true);
      return next;
    });
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const session = await this.freshSession();
    const url = new URL(path, session.apiUrl);
    if (url.origin !== session.apiUrl || !url.pathname.startsWith("/api/") && url.pathname !== "/v3/api-docs") throw new Error("Request must target this LookAndTry API");
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(credentials(session))) headers.set(name, value);
    // Scope is pinned by the session, never by an execution input.
    if (session.context.organizationId === null) headers.delete("X-Organization-Id");
    return fetchResponse(url, { ...init, headers, redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    }, this.fetcher);
  }

  async json(path: string, init: RequestInit = {}): Promise<unknown> { return jsonResponse(await this.request(path, init)); }

  async status(): Promise<unknown> {
    const session = await this.freshSession();
    const current = await account(session);
    if (current.identity.id !== session.identityId) throw new Error("LookAndTry account changed; sign in again");
    return { apiUrl: session.apiUrl, issuer: session.issuer, context: session.context, expiresAt: session.expiresAt, account: current };
  }

  async logout(): Promise<void> {
    await withSessionLock(this.sessionFile, async () => {
      const session = await this.session();
      // Revoking the refresh family invalidates its access tokens in Identity.
      const response = await oauthForm(session.revocationEndpoint, {
        client_id: session.clientId, token: session.refreshToken ?? session.accessToken,
        token_type_hint: session.refreshToken ? "refresh_token" : "access_token",
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Identity revocation failed (HTTP ${response.status}); local session retained`); }
      await response.body?.cancel();
      await rm(this.sessionFile);
    });
  }
}
