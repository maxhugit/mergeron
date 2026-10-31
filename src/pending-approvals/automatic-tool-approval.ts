/** Recognize engine-authored approvals, never arbitrary questions or login forms. */
import { record } from './request-validation';
import { presentElicitation } from './elicitation-interaction';

export function automaticToolApproval(
  method: string,
  params: Record<string, unknown>,
): { action: 'accept'; content: Record<string, never> } | null {
  if (method !== 'mcpServer/elicitation/request' || params.mode !== 'form')
    return null;
  const meta = record(params._meta);
  if (
    meta?.codex_approval_kind !== 'mcp_tool_call' ||
    meta.codex_requires_user_input === true
  )
    return null;
  const prompt = presentElicitation(params);
  if (!prompt.supported || prompt.url || prompt.fields.length !== 0)
    return null;
  return { action: 'accept', content: {} };
}
