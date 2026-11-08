import { z } from "zod";
import { apiOrigin, issuerUrl } from "./session.js";
import { ApiError, fetchResponse, jsonResponse, readBounded } from "./transport.js";
import { VERSION } from "./version.js";

const metadataSchema = z.object({
  issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), revocation_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()),
});
export const tokensSchema = z.object({
  access_token: z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/), token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive().max(31_536_000), refresh_token: z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/).optional(),
  scope: z.string().optional(),
});
export type Tokens = z.infer<typeof tokensSchema>;

export async function discover(issuer: string) {
  const canonical = issuerUrl(issuer);
  const response = await fetchResponse(new URL(`${canonical}/.well-known/openid-configuration`), {
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" },
  });
  const metadata = metadataSchema.parse(await jsonResponse(response));
  if (metadata.issuer !== canonical || !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("Identity issuer mismatch or S256 PKCE is unavailable");
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.revocation_endpoint]) {
    const url = new URL(endpoint);
    apiOrigin(url.origin);
    if (url.origin !== new URL(canonical).origin || url.username || url.password || url.search || url.hash) {
      throw new Error("Identity endpoints must remain on the selected issuer origin");
    }
  }
  return metadata;
}

export async function oauthForm(endpoint: string, parameters: Record<string, string>): Promise<Response> {
  return fetchResponse(new URL(endpoint), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": `lookctl/${VERSION}` },
    body: new URLSearchParams(parameters),
  });
}

export async function tokenRequest(endpoint: string, parameters: Record<string, string>): Promise<Tokens> {
  const response = await oauthForm(endpoint, parameters);
  if (!response.ok) {
    // Token endpoint diagnostics must never include a credential echoed by a provider.
    await readBounded(response);
    throw new ApiError(response.status, "Identity token request rejected; sign in again if the grant expired or was revoked");
  }
  return tokensSchema.parse(await jsonResponse(response));
}
