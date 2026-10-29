import { createContext } from 'react';

export const PreviewLinkContext = createContext<{
  projectId: string;
  threadId: string;
} | null>(null);

/** A hint only: the server-observed instance must match before minting a grant. */
export function couldBePreviewLink(href: string) {
  try {
    const url = new URL(href);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\./.test(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}
