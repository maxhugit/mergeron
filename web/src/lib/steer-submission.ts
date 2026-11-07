import { normalizeThreadItem } from './thread-item-normalizer';
import { useTimelineStore } from '@/stores/timeline-store';
import { getApiErrorMessage } from './api-error';

/** Captured by the mutation before its request, and owned by the sending agent. */
export function beginSteerSubmission(
  threadId: string,
  turnId: string,
  input: unknown,
) {
  const localId = crypto.randomUUID();
  const normalized = normalizeThreadItem(
    { type: 'userMessage', content: input },
    false,
  );
  if (normalized.kind === 'userMessage')
    useTimelineStore
      .getState()
      .addSteeringMessageForThread(
        threadId,
        turnId,
        localId,
        normalized.message.text,
        normalized.message.images,
      );
  return { threadId, localId };
}

export function rejectSteerSubmission(
  submission: ReturnType<typeof beginSteerSubmission>,
  error: unknown,
) {
  const store = useTimelineStore.getState();
  if (!store.getThreadRuntime(submission.threadId)) return;
  store.rejectSteeringMessageForThread(submission.threadId, submission.localId);
  store.addSystemErrorForThread(submission.threadId, getApiErrorMessage(error));
}
