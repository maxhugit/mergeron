/** A per-turn budget, independent of GitHub's own API quotas and read concurrency. */
export const DEFAULT_MCP_CALLS_PER_TURN = 1000;

export function internalMcpCallBudget(
  value = process.env.MERGERON_MCP_CALLS_PER_TURN,
): number {
  if (!value || !/^\d+$/.test(value)) return DEFAULT_MCP_CALLS_PER_TURN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 10000
    ? parsed
    : DEFAULT_MCP_CALLS_PER_TURN;
}
