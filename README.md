# lookandtry-ctl

`lookctl` is the standalone LookAndTry business API client and local stdio MCP
server. It discovers operations from the running backend's `/v3/api-docs` and
executes them with the signed-in user's existing permissions and context.

## Build and use locally

Install the pinned toolchain with mise (Node 24.16.0, pnpm 10.34.5):

```sh
mise run setup
mise run check
mise run package
mise run test:packaged
```

The native executable is created in `build/lookctl-0.1.0-<os>-<arch>/lookctl`
(`lookctl.exe` on Windows), and its archive in `dist/releases/`. Copy the binary
into a directory on PATH. Keep the included runtime/dependency licenses with it.
The installed CLI and MCP need neither Node nor a source checkout.

This source project prepares release builds and installers; a hosted repository,
published release and live Identity client must be provisioned separately.
`install.sh` and `install.ps1` target future GitHub releases in
`mathias8dev/lookandtry-ctl`; they verify archive checksums before replacing a
binary. They cannot install a release that has not been published.

## Prepare Identity

The backend must already accept access tokens from the selected LookAndTry
Identity issuer and introspect the registered LookAndTry API resource.
Register **one public native OAuth client** named `lookctl` in that same
Identity environment. Use `docs/identity-client.example.json` as the current
Identity administration API request body, replacing `defaultResource` with the
**exact existing resource URI**, including its path/trailing slash. Submit it
through the Identity administration console or its existing
`POST /identity/admin/tenants/{tenantId}/clients` operation as an authorized operator.
Do not create a second API resource or rotate introspection credentials.

The client has no secret, uses explicit consent and the hosted browser flow,
and permits `http://127.0.0.1/oauth2/callback`. Identity's NATIVE registration
matches any ephemeral loopback port while preserving the host and callback
path. `nativeAuthenticationEnabled: false` keeps credential collection in the
hosted Identity UI. Enable the existing `lookandtry.api` resource scope and
`openid email offline_access` client scopes. No password or integration key is
used by the CLI. The backend exposes public registration metadata at
`/api/auth/native/config`; no new permission or database migration is needed.

The user needs an existing subject-to-product identity link and active membership
for organization/platform contexts. Existing account-linking workflows own
linking; the CLI never infers identity from matching email addresses.

## Sign in

Supply only the API origin for the chosen environment:

```sh
lookctl login --api-url https://api.lookandtry.example
lookctl status
```

Replace the example URL, or supply it with `LOOKCTL_API_URL`. The backend's public
`GET /api/auth/native/config` returns its configured Identity issuer, `lookctl`
client ID and scopes. The backend must include this route and have its external
resource server enabled; update/restart an older backend before logging in.
The registered OAuth client's **default resource** supplies the API audience,
so the user does not enter an issuer, resource URI or organization ID.
Identity discovery still validates the exact issuer, same-origin endpoints and
S256 PKCE. TLS includes system, bundled and extra CAs; HTTP is allowed only on
localhost and 127.0.0.1. Credentials are never forwarded across redirects.

A random loopback port receives the browser's single-use authorization code.
State, callback host/path and any returned issuer are checked before exchanging
the code with the PKCE proof. The backend's `/api/auth/me` then verifies the
access token and returns its verified personal context plus available
organization/platform memberships. One context is selected automatically;
multiple contexts prompt in the terminal with names:

```text
1. Personnel
2. Organisation Boutique Paris
3. Administration plateforme
```

The chosen context is checked again through `/api/auth/me` before saving the
session. The system organization ID comes from the server's platform context;
the user does not need to know it. The backend continues to enforce live roles,
permissions, membership, route boundaries and private-media policies. If context
selection, verification or local storage fails, the issued grant is revoked.

For noninteractive use, selectors filter the contexts actually offered by the
backend:

```sh
lookctl login --api-url https://api.lookandtry.example --context PLATFORM
lookctl login --api-url https://api.lookandtry.example --context CONSUMER
lookctl login --api-url https://api.lookandtry.example \
  --context ORGANIZATION --organization-id 123
```

`--context PLATFORM` automatically resolves the sole available platform context.
When several matching contexts remain, an interactive terminal is required;
headless invocation fails with explicit selectors rather than guessing.
Selecting a context never grants access the account does not already possess.

`--no-browser` prints a URL to open manually. The callback must reach the machine
running lookctl; remote shells need loopback port forwarding. Login expires
after five minutes. MCP never starts an interactive login.

Sessions live in
`${XDG_CONFIG_HOME:-$HOME/.config}/lookandtry/lookctl/session.json`. POSIX session
directories are private (`0700`), files are atomic (`0600`), and symlinks are
rejected. On Windows keep the session in the account-private user profile.
`LOOKCTL_SESSION_FILE` selects a separate instance/account/context. To change
context, use a separate session file or logout and login again. Running MCP
clients reject identity, issuer, client, API or context drift until restarted.

Expiring access tokens refresh under a per-session lock. Rotation is persisted
before other network calls and is never automatically retried. If a process
crashes holding `session.json.lock`, stop all clients sharing the session before
removing that lock. Revoked/expired refresh grants require a new login.

```sh
lookctl logout
```

Logout revokes the Identity grant before deleting local credentials. A network
or revocation failure keeps the session available for a retry. It does not log
out other browser applications or other accounts.

## Discover and execute

```sh
lookctl operations products --offset 0 --limit 25
lookctl schema OPERATION_ID
lookctl execute OPERATION_ID --input request.json --dry-run
lookctl execute OPERATION_ID --input request.json
```

The IDs and contracts come from the backend, including platform, organization
and consumer APIs. Discovery returns 1–100 operations per page. It is a catalog,
not a permission grant: inaccessible operations continue to return backend
errors. Internal session-vault and interactive `/api/auth/*` routes are excluded.
There is no separately maintained command/DTO catalog.

Follow the inspected schema; omit unused input sections:

```json
{
  "path": { "id": "123" },
  "query": { "page": 0, "size": 20, "sort": ["name,asc"] },
  "headers": {},
  "body": { "name": "Example" }
}
```

`--input -` reads stdin. Identity, organization and credential headers come from
the session and cannot be replaced by input. Ordinary operation headers retain
their discovered API semantics. A dry run prepares the request without executing
the business operation; it may refresh authentication and fetch OpenAPI. It does
not perform server-side business validation. Writes are never automatically
retried. After an uncertain result, inspect existing operation/job state and
idempotency contracts before retrying. Cancellation of an HTTP call does not undo
a write or cancel a durable job; use the job's existing cancellation operation.

File downloads create a new private file and refuse to overwrite an existing one:

```sh
lookctl execute DOWNLOAD_OPERATION_ID --input parameters.json --output private.png
lookctl execute RAW_UPLOAD_OPERATION_ID --input parameters.json \
  --body-file artwork.png --content-type image/png
lookctl execute TRY_ON_OPERATION_ID --input parameters.json \
  --file 'userPhoto=/path/photo.png;type=image/png' --field 'items=[]'
```

For multipart, repeat `--file`/`--field` as needed; `;type=` defaults to
`application/octet-stream`. The multipart boundary is generated automatically.
`parameters.json` supplies path/query/headers; use the exact file/field names from
`schema`. MCP accepts `multipart.fields` and `multipart.files` entries with
`name`, `filename`, `contentType`, `dataBase64`. JSON and ordinary API replies are
bounded at 2 MiB, OpenAPI at 16 MiB, and uploads at 64 MiB total (backend limits
also apply). Larger downloads stream through `--output`; MCP binary replies are
bounded base64. Private media stays on the existing owner-authorized API paths.

CLI results are JSON on stdout; failures use stderr and a nonzero exit code.
Browser URLs use stderr. Session credentials are never printed by status or dry
run. Operation results retain the API's authorized data semantics.

## MCP

After `lookctl login`, configure your MCP host to launch the installed binary:

```json
{
  "mcpServers": {
    "lookandtry": {
      "command": "lookctl",
      "args": ["mcp"]
    }
  }
}
```

Use an absolute executable path if the host does not inherit your PATH. Supply
`LOOKCTL_SESSION_FILE` through the host's environment for a nondefault session.
The host starts the server; stdout is reserved for protocol traffic.

| Tool | Purpose |
| --- | --- |
| `look_status` | Current user, API instance, context and live permissions |
| `look_search_operations` | Bounded operation discovery |
| `look_operation_schema` | Exact contract, component schemas and enums |
| `look_execute` | Execute an existing API operation as the signed-in user |

Execution is marked potentially destructive because business actions may create,
charge, send, publish or delete. The host owns approval policy; backend
permissions and tenant/owner isolation remain authoritative. Failures become
`isError` results. CLI and MCP share the same session/client/catalog/executor.

## Validation and distribution

Tests run real CLI/MCP subprocesses against local HTTP/HTTPS API and Identity
fixtures, including browser callbacks, PKCE, permissions, rotation, revocation,
private storage, multipart/binary transfers and system CA trust. Packaged tests
copy the binary into an isolated temporary directory before invoking it and its
MCP server. These are client contract tests; a deployed login also requires the
Identity registration and actual user approval described above.

CI builds Linux glibc x64/ARM64, macOS Intel/Apple Silicon, and Windows x64/ARM64
on matching runners. Linux TLS tests require OpenSSL. macOS binaries are ad-hoc
signed; Windows binaries are unsigned. Alpine/musl is not a supported target.
Foreign-platform binaries are verified by their CI jobs, not by a local Linux run.

Version comes from package.json. The workflow prepares all six targets on main
and PRs. Release publication is manual from main with `publish` enabled, after
all target builds and packaged tests pass. Archive provenance, exact source
revision and SHA-256 are verified; immutable tags/assets cannot be overwritten.
No npm publication or backend deployment is performed.
