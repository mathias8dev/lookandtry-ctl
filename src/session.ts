import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export enum ContextType { CONSUMER = "CONSUMER", ORGANIZATION = "ORGANIZATION", PLATFORM = "PLATFORM" }
export const contextSchema = z.object({
  contextType: z.enum(ContextType), organizationId: z.number().int().positive().safe().nullable(),
}).strict().refine(value => value.contextType === ContextType.CONSUMER ? value.organizationId === null : value.organizationId !== null,
  "Consumer context has no organization; organization and platform contexts require an organization ID");
const tokenSchema = z.string().min(1).max(16384).regex(/^[\x21-\x7e]+$/);
export const sessionSchema = z.object({
  apiUrl: z.string(), issuer: z.string(), clientId: z.string().min(1), resource: z.string().optional(),
  tokenEndpoint: z.string(), revocationEndpoint: z.string(),
  accessToken: tokenSchema, refreshToken: tokenSchema.optional(),
  identityId: z.number().int().positive().safe(), email: z.string(),
  context: contextSchema, expiresAt: z.iso.datetime(),
}).strict();
export type Session = z.infer<typeof sessionSchema>;

export function apiOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new Error("API URL must be an HTTPS origin (HTTP is allowed only on localhost or 127.0.0.1)");
  }
  return url.origin;
}

export function sessionPath(): string {
  return process.env.LOOKCTL_SESSION_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "lookandtry", "lookctl", "session.json");
}

export function issuerUrl(value: string): string {
  const url = new URL(value);
  apiOrigin(url.origin);
  if (url.username || url.password || url.search || url.hash) throw new Error("Issuer must be an HTTPS URL without credentials, query or fragment");
  return url.href.replace(/\/$/, "");
}

export function validateSession(session: Session): void {
  if (apiOrigin(session.apiUrl) !== session.apiUrl || issuerUrl(session.issuer) !== session.issuer) throw new Error("Noncanonical session URL");
  for (const endpoint of [session.tokenEndpoint, session.revocationEndpoint]) {
    const url = new URL(endpoint);
    if (url.origin !== new URL(session.issuer).origin || url.username || url.password || url.hash || url.search) {
      throw new Error("OAuth endpoints must belong to the selected Identity origin");
    }
  }
  if (session.resource !== undefined) {
    const resource = new URL(session.resource);
    if (resource.origin !== session.apiUrl || resource.username || resource.password || resource.hash || resource.search) throw new Error("OAuth resource must belong to the API origin");
  }
}

function requirePrivate(stat: Stats, kind: "file" | "directory"): void {
  if ((kind === "file" ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink() ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error(`Session ${kind} must belong to you, be private, and not be a symlink`);
  }
}

export async function loadSession(path = sessionPath()): Promise<Session> {
  await requireDirectory(path);
  requirePrivate(await lstat(path), "file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requirePrivate(await handle.stat(), "file");
    const session = sessionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    validateSession(session);
    if (process.env.LOOKCTL_API_URL && apiOrigin(process.env.LOOKCTL_API_URL) !== session.apiUrl) {
      throw new Error("LOOKCTL_API_URL differs from the stored session; select the matching LOOKCTL_SESSION_FILE");
    }
    return session;
  } finally { await handle.close(); }
}

async function requireDirectory(path: string): Promise<void> {
  requirePrivate(await lstat(dirname(path)), "directory");
}

export async function saveSession(value: Session, path = sessionPath(), replace = false): Promise<void> {
  const session = sessionSchema.parse(value);
  validateSession(session);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await requireDirectory(path);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(session)); await handle.sync(); }
    finally { await handle.close(); }
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Refresh and logout must never race on the same rotating grant. */
export async function withSessionLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Another lookctl process is updating this session; retry later. After a crash, remove the .lock file only once all clients are stopped.");
    throw error;
  });
  try { return await work(); }
  finally { await lock.close(); await rm(lockPath); }
}
