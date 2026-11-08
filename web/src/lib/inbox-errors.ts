/** Transient local error events. The mounted inbox persists them for the authenticated person. */
export interface InboxError {
  message: string;
  threadId: string;
}
const listeners = new Set<(error: InboxError) => void>();
export function reportInboxError(error: InboxError) {
  for (const listener of listeners) listener(error);
}
export function subscribeInboxErrors(listener: (error: InboxError) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
