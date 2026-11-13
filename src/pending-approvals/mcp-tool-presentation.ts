import { INTERNAL_MCP_IDENTITIES } from '../internal-mcp/internal-mcp-tools';
import { record } from './request-validation';
import type { McpToolPresentationDto } from './dto/interaction.dto';

const SECRET =
  /password|passwd|secret|token|api[_-]?key|authorization|cookie|credential/i;
/** Bounded informational projection. It never changes admission or the decision. */
export function presentMcpTool(
  params: Record<string, unknown>,
): McpToolPresentationDto | undefined {
  if (!['form', 'openaiForm', 'openai/form'].includes(String(params.mode)))
    return undefined;
  const meta = record(params._meta);
  if (meta?.codex_approval_kind !== 'mcp_tool_call') return undefined;
  const text = (value: unknown, limit: number) =>
    typeof value === 'string' && value.length <= limit ? value : null;
  const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 12) throw Error('Arguments too deep');
    if (Array.isArray(value))
      return value.map((child) => sanitize(child, depth + 1));
    const object = record(value);
    if (object)
      return Object.fromEntries(
        Object.entries(object).map(([key, child]) => [
          key,
          SECRET.test(key) ? '[masked]' : sanitize(child, depth + 1),
        ]),
      );
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        for (const key of [...url.searchParams.keys()])
          if (SECRET.test(key)) url.searchParams.set(key, '[masked]');
        return url.toString();
      } catch {
        return value;
      }
    }
    return value;
  };
  let argumentsJson: string | null = null;
  try {
    // Display-only metadata must never override the actual invocation subject.
    const raw: unknown = meta.tool_params;
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed !== undefined) {
      const encoded = JSON.stringify(sanitize(parsed), null, 2);
      if (encoded && encoded.length <= 32768) argumentsJson = encoded;
    }
  } catch {
    /* A missing or unusable argument set must stay visibly unavailable. */
  }
  const name = text(meta.tool_name, 300);
  const known =
    params.serverName === 'mergeron_internal'
      ? INTERNAL_MCP_IDENTITIES.find(
          (identity) => identity.name === name || identity.operation === name,
        )
      : undefined;
  return {
    name,
    ...(known ? { titleFr: known.titleFr } : {}),
    title: known?.title ?? text(meta.tool_title, 1000),
    description: text(meta.tool_description, 6000),
    argumentsJson,
  };
}
