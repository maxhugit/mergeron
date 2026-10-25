import { createContext, useContext } from 'react';
import type { TurnItem } from '@/types/timeline';

export const ExpandedTechnicalDetails = createContext(false);
export const useExpandedTechnicalDetails = () =>
  useContext(ExpandedTechnicalDetails);

export function isTechnicalItem(item: TurnItem): boolean {
  if (
    item.type === 'functionCallOutput' &&
    item.outputParts.some(
      (part) => part.type === 'image' || part.type === 'audio',
    )
  )
    return false;
  if (
    item.type === 'dynamicToolCall' &&
    item.contentItems.some(
      (part) => part.type === 'image' || part.type === 'audio',
    )
  )
    return false;
  return [
    'reasoning',
    'commandExecution',
    'mcpToolCall',
    'functionCallOutput',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'hookPrompt',
    'fileChange',
    'sleep',
    'contextCompaction',
    'enteredReviewMode',
    'exitedReviewMode',
  ].includes(item.type);
}

/** Failed operations remain visible even when routine technical activity is hidden. */
export function isFailedTechnicalItem(item: TurnItem): boolean {
  return (
    (item.type === 'commandExecution' &&
      item.exitCode !== undefined &&
      item.exitCode !== 0) ||
    (item.type === 'dynamicToolCall' &&
      (item.success === false || item.status === 'failed')) ||
    (item.type === 'mcpToolCall' && item.failed === true) ||
    (item.type === 'collabAgentToolCall' &&
      (['failed', 'errored'].includes(item.status) ||
        item.agentStates.some((agent) =>
          ['failed', 'errored'].includes(agent.status),
        )))
  );
}
