# LookAndTry CLI and MCP

Use the mathias-engineering skill. This standalone project contains the LookAndTry API client only. Never copy backend sources, Git history, environment files, credentials or stored sessions into it.

- `lookctl` and its stdio MCP server share one authenticated HTTP client and the running backend's `/v3/api-docs` catalog. Keep one implementation of discovery, schema inspection and execution. Infrastructure commands belong to lookX/tooling.
- Discover the issuer/client/scopes from the backend, then authenticate through the existing LookAndTry Identity browser authorization flow with S256 PKCE and a registered public native client. Never collect passwords, use integration keys, or match/link accounts by email. Discover contexts from the verified personal `/api/auth/me` response, prompt by name when ambiguous, and revalidate the chosen context. The resource server owns live permissions and membership checks.
- Sessions are private and pinned to API origin, issuer, client, user, context and organization. Never log credentials, forward them across redirects, accept credential/context overrides, or disable TLS verification. Preserve system/extra CA trust.
- Serialize refresh and logout for each session. Persist successful token rotation before further network calls, retain credentials on revocation failure, and never automatically retry uncertain writes or refreshes.
- Model finite vocabularies with enums. Keep application behavior independent of packaging.
- Ship standalone binaries with the pinned Node runtime, including MCP without Node or a checkout. Do not publish to npm. Version comes from package.json.
- `pnpm check`, `pnpm package`, and `pnpm test:packaged` are the delivery gates. API/Identity fixtures prove client contracts, not a deployed login. Report live registration and foreign-platform validation separately.
- CI prepares Linux/macOS/Windows artifacts on matching hosts/architectures. Publishing requires manual approval from main after all targets pass. Never overwrite immutable releases.
- Do not commit, push, publish, deploy, provision Identity or change external settings without explicit authorization. Review the complete diff and file inventory for unrelated content and secrets.
