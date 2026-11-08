import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { ContextType, contextSchema, type Session } from "./session.js";

const availableContextSchema = z.object({
  contextType: z.enum(ContextType), organizationId: z.number().int().positive().safe().nullable(),
  organizationName: z.string().nullable().optional(), organizationSlug: z.string().nullable().optional(),
}).passthrough();
export type ContextOption = { context: Session["context"]; label: string };
export type ContextSelector = { contextType?: ContextType; organizationId?: number };
type ContextPrompt = (options: readonly ContextOption[], signal?: AbortSignal) => Promise<number>;

/** Both the authenticated personal context and available memberships come from /api/auth/me. */
export function contextOptions(account: { currentContext: unknown; availableContexts?: unknown }): ContextOption[] {
  const current = availableContextSchema.parse(account.currentContext);
  const memberships = z.array(availableContextSchema).parse(account.availableContexts);
  const seen = new Set<string>();
  const result: ContextOption[] = [];
  for (const option of [current, ...memberships]) {
    const context = contextSchema.parse({ contextType: option.contextType, organizationId: option.organizationId });
    const key = `${context.contextType}:${context.organizationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const organization = option.organizationName ?? option.organizationSlug ?? `#${context.organizationId}`;
    const label = context.contextType === ContextType.CONSUMER ? "Personnel" :
      context.contextType === ContextType.PLATFORM ? "Administration plateforme" : `Organisation ${organization}`;
    result.push({ context, label });
  }
  return result;
}

export async function selectContext(options: readonly ContextOption[], selector: ContextSelector = {},
  prompt: ContextPrompt = promptForContext, signal?: AbortSignal): Promise<Session["context"]> {
  const matching = options.filter(option =>
    (selector.contextType === undefined || option.context.contextType === selector.contextType) &&
    (selector.organizationId === undefined || option.context.organizationId === selector.organizationId));
  if (!matching.length) throw new Error("No accessible context matches this selection; sign in without --context/--organization-id to list your contexts");
  if (matching.length === 1) return matching[0]!.context;
  const index = await prompt(matching, signal);
  if (!Number.isInteger(index) || !matching[index]) throw new Error("Invalid context selection");
  return matching[index]!.context;
}

async function promptForContext(options: readonly ContextOption[], signal?: AbortSignal): Promise<number> {
  if (!process.stdin.isTTY) {
    const selectors = options.map(({ context }) => `--context ${context.contextType}${context.organizationId === null ? "" : ` --organization-id ${context.organizationId}`}`);
    throw new Error(`Several contexts are available. Run login in a terminal to choose, or select one explicitly: ${selectors.join("; ")}`);
  }
  process.stderr.write("Choisis ton contexte LookAndTry :\n");
  for (const [index, option] of options.entries()) process.stderr.write(`${index + 1}. ${option.label}\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const cancelled = new AbortController();
  const cancel = () => cancelled.abort(new Error("Context selection cancelled"));
  terminal.once("SIGINT", cancel); terminal.once("close", cancel);
  try {
    const selectionSignal = signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal;
    return Number(await terminal.question("Numéro du contexte : ", { signal: selectionSignal })) - 1;
  } finally {
    terminal.removeListener("SIGINT", cancel); terminal.removeListener("close", cancel); terminal.close();
  }
}
