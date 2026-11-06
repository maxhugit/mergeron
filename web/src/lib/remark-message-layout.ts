/** Preserve chat line breaks without rewriting code, URLs or Markdown syntax. */
interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

const endings = (text: string) => (text.match(/\r\n|\r|\n/g) ?? []).length;
const gap = (lines: number): Node => ({
  type: 'paragraph',
  children: [],
  data: { hProperties: { 'data-message-blank-lines': lines } },
});

export function remarkMessageLayout() {
  return (tree: Node, file: { value: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : '';
    const walk = (node: Node) => {
      if (!node.children || ['code', 'inlineCode', 'html'].includes(node.type))
        return;
      const children: Node[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && /[\r\n]/.test(child.value ?? '')) {
          (child.value ?? '').split(/\r\n|\r|\n/).forEach((value, index) => {
            if (index) children.push({ type: 'break' });
            if (value) children.push({ type: 'text', value });
          });
        } else {
          walk(child);
          children.push(child);
        }
      }
      node.children = children;
    };
    walk(tree);
    // Markdown consumes blank separators. Preserve additional blank lines at
    // the root, leaving normal paragraph/list spacing and code contents alone.
    const original = tree.children ?? [];
    const children: Node[] = [];
    let previousEnd = 0;
    for (const child of original) {
      const start = child.position?.start.offset;
      if (start !== undefined) {
        const whitespace = source.slice(previousEnd, start);
        if (/^\s*$/.test(whitespace)) {
          const lines = endings(whitespace) - (children.length ? 2 : 0);
          if (lines > 0) children.push(gap(lines));
        }
      }
      children.push(child);
      previousEnd = child.position?.end.offset ?? source.length;
    }
    if (original.length) {
      const whitespace = source.slice(previousEnd);
      if (/^\s*$/.test(whitespace) && endings(whitespace))
        children.push(gap(endings(whitespace)));
    }
    tree.children = children;
  };
}
