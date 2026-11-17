import { describe, expect, it } from 'vitest';
import { internalMcpCallBudget } from './internal-mcp-limits';

describe('internal MCP per-turn budget', () => {
  it.each(['', '0', '99', '10001', '-1', '1.5', 'NaN', 'Infinity', '1000x'])(
    'uses the bounded default for invalid configuration %s',
    (value) => {
      expect(internalMcpCallBudget(value)).toBe(1000);
    },
  );
  it.each([100, 1000, 2500, 10000])(
    'accepts a configured budget of %s',
    (value) => {
      expect(internalMcpCallBudget(String(value))).toBe(value);
    },
  );
});
