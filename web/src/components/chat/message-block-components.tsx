import type { ComponentProps } from 'react';
import type Markdown from 'react-markdown';

/** Shared block semantics for human, streaming and completed Markdown. */
export const messageBlockComponents: ComponentProps<
  typeof Markdown
>['components'] = {
  h1: ({ children, node }) => (
    <h1
      data-reading-block={node?.position?.start.offset}
      className="mb-3 mt-5 text-xl font-bold first:mt-0"
    >
      {children}
    </h1>
  ),
  h2: ({ children, node }) => (
    <h2
      data-reading-block={node?.position?.start.offset}
      className="mb-2 mt-4 text-lg font-semibold first:mt-0"
    >
      {children}
    </h2>
  ),
  h3: ({ children, node }) => (
    <h3
      data-reading-block={node?.position?.start.offset}
      className="mb-2 mt-3 text-base font-semibold first:mt-0"
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-2 mt-3 text-sm font-semibold first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-2 mt-3 text-sm font-medium first:mt-0">{children}</h6>
  ),
  p: ({ children, node }) => {
    const lines = Number(node?.properties?.['data-message-blank-lines']);
    if (Number.isInteger(lines) && lines > 0)
      return (
        <div
          data-message-blank-lines={lines}
          aria-hidden="true"
          style={{ height: `${lines}lh` }}
        />
      );
    return (
      <p
        data-reading-block={node?.position?.start.offset}
        className="mb-2 last:mb-0"
      >
        {children}
      </p>
    );
  },
  ul: ({ children }) => (
    <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="mb-2 ml-4 list-decimal space-y-1">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="text-sm">{children}</li>,
  table: ({ children }) => (
    <div className="my-2 overflow-auto">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border">{children}</thead>
  ),
  th: ({ children, style }) => (
    <th
      style={{ textAlign: style?.textAlign }}
      className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={{ textAlign: style?.textAlign }}
      className="border-t border-border/50 px-3 py-1.5 text-sm"
    >
      {children}
    </td>
  ),
};
