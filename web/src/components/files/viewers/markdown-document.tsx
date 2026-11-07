/** A local, inert Markdown reading view over the same working model as Monaco. */
import {
  useCallback,
  useDeferredValue,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import type { TextModel } from '@/stores/document-store';

const plugins = [remarkGfm];
const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

export function MarkdownDocument({ model }: { model: TextModel }) {
  const { t } = useTranslation();
  const article = useRef<HTMLElement>(null);
  const prefix = useId();
  const subscribe = useCallback(
    (notify: () => void) => {
      const listener = model.onDidChangeContent(notify);
      return () => listener.dispose();
    },
    [model],
  );
  const snapshot = useCallback(() => model.getValue(), [model]);
  const content = useDeferredValue(useSyncExternalStore(subscribe, snapshot));
  const { outline, components } = useMemo(() => {
    const outline: Components = {};
    const components: Components = {};
    for (const tag of headings as (keyof Pick<
      Components,
      'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    >)[]) {
      const Tag = tag;
      components[tag] = ({ children, node }) => (
        <Tag
          id={`${prefix}-${node?.position?.start.line}`}
          data-line={node?.position?.start.line}
          className="scroll-mt-4"
        >
          {children}
        </Tag>
      );
      outline[tag] = ({ children, node }) => (
        <a
          href={`#${prefix}-${node?.position?.start.line}`}
          className="block truncate rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          style={{ paddingLeft: `${(Number(tag[1]) - 1) * 12 + 8}px` }}
          onClick={(event) => {
            event.preventDefault();
            article.current
              ?.querySelector(`[data-line="${node?.position?.start.line}"]`)
              ?.scrollIntoView({ block: 'start' });
          }}
        >
          {children}
        </a>
      );
    }
    return { outline, components };
  }, [prefix]);
  return (
    <div
      className="h-full min-w-0 overflow-auto bg-background text-foreground"
      aria-label={t('markdownRead')}
    >
      <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
        <nav
          aria-label={t('markdownContents')}
          className="hidden rounded-lg border p-3 text-sm has-[a~a]:block"
        >
          <p className="mb-2 font-medium">{t('markdownContents')}</p>
          <Markdown
            remarkPlugins={plugins}
            allowedElements={[
              ...headings,
              'strong',
              'em',
              'code',
              'del',
              'a',
              'br',
            ]}
            components={{ ...outline, a: ({ children }) => <>{children}</> }}
            skipHtml
          >
            {content}
          </Markdown>
        </nav>
        <article
          ref={article}
          className="min-w-0 text-sm leading-7 [overflow-wrap:anywhere] [&_h1]:mb-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:mt-4 [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_p]:mb-4 [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:mb-1 [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_hr]:my-6 [&_a]:text-primary [&_a]:underline [&_th]:border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_td]:border [&_td]:px-3 [&_td]:py-2"
        >
          <Markdown
            remarkPlugins={plugins}
            skipHtml
            components={{
              ...components,
              table: ({ children }) => (
                <div className="mb-4 max-w-full overflow-x-auto">
                  <table className="w-full border-collapse">{children}</table>
                </div>
              ),
              // Documents never execute HTML or silently fetch third-party images.
              img: ({ alt }) => (
                <span className="text-muted-foreground">
                  {t('markdownImage', { alt: alt ?? '' })}
                </span>
              ),
              a: ({ href, children }) =>
                href && /^(?:https?:|mailto:)/i.test(href) ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
            }}
          >
            {content}
          </Markdown>
        </article>
      </div>
    </div>
  );
}
