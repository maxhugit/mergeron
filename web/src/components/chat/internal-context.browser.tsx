/** Historical context goes through the real normalizer and message renderer. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { normalizeThreadItem } from '@/lib/thread-item-normalizer';
import { UserMessageBubble } from './user-message-bubble';
import { MarkdownRenderer } from './markdown-renderer';
import { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(cleanup);
for (const width of [390, 1180]) {
  test(`keeps repeated internal snapshots out of the conversation at ${width}px`, async () => {
    await i18nReady;
    await page.viewport(width, 850);
    const context = ['mergeron_agent_instructions', 'mergeron_project_context', 'project_shared_knowledge', 'document_publication']
      .map(tag => `<${tag}>\nInternal project context ${'private rules '.repeat(100)}\n</${tag}>`).join('\n\n');
    const items = [context, context + '\n\nPrépare le document de cadrage.', context, '<mergeron_context_refresh>\nRead project_context_read\n</mergeron_context_refresh>\n\nAjoute les objectifs du projet.'];
    render(<main className="min-h-dvh bg-background p-4 text-foreground"><div className="mx-auto max-w-2xl space-y-6">
      <h1>Conversation de démonstration</h1>
      {items.map((text, index) => {
        const entry = normalizeThreadItem({ type: 'userMessage', content: [{ type: 'text', text }], text }, true);
        if (entry.kind !== 'userMessage') return null;
        return <section key={index} className="rounded-xl border bg-muted p-4"><UserMessageBubble content={entry.message.text} images={entry.message.images} threadCwd={null} threadId={null} /></section>;
      })}
      <section className="rounded-xl border p-4"><MarkdownRenderer content="Le document contient désormais les objectifs du projet. Une nouvelle version conserve le travail précédent." completed /></section>
    </div></main>);
    expect(screen.getByText('Prépare le document de cadrage.')).toBeVisible();
    expect(screen.getByText('Ajoute les objectifs du projet.')).toBeVisible();
    expect(screen.queryByText(/Internal project context|private rules|project_context_read/)).not.toBeInTheDocument();
    expect(document.querySelectorAll('section')).toHaveLength(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    await page.screenshot({ path: `../../../.vitest-screenshots/internal-context-${width}.png` });
  });
}
