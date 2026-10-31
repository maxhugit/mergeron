/** Approval prompts must never be an escape hatch out of a managed filesystem. */
import type { v2 } from '../codex/codex-schema';

export function boundedApprovalPolicy(
  policy: v2.AskForApproval | null | undefined,
): v2.AskForApproval {
  if (policy == null || policy === 'never') return 'never';
  return {
    granular: {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations:
        typeof policy === 'object' ? policy.granular.mcp_elicitations : true,
    },
  };
}
