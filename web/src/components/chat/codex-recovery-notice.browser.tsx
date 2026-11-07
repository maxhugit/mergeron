import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { CodexRecoveryNotice } from './codex-recovery-notice';
import '@/index.css';

afterEach(cleanup);
test('shows waiting then availability and failure accessibly on desktop and mobile', async () => {
  for (const width of [390, 1280]) {
    await page.viewport(width, 720);
    const view = render(
      <CodexRecoveryNotice
        phase="restarting"
        message="Le serveur Codex redémarre. En attente pour reprendre ce fil."
      />,
    );
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.querySelector('.animate-spin')).not.toBeNull();
    expect(status.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `../../../.vitest-screenshots/codex-restarting-${width}.png`,
    });
    view.rerender(
      <CodexRecoveryNotice
        phase="ready"
        message="Le serveur Codex est de nouveau disponible."
      />,
    );
    expect(status.getAttribute('aria-busy')).toBe('false');
    expect(status.querySelector('.animate-spin')).toBeNull();
    expect(status.textContent).toContain('de nouveau disponible');
    await page.screenshot({
      path: `../../../.vitest-screenshots/codex-ready-${width}.png`,
    });
    view.rerender(
      <CodexRecoveryNotice
        phase="failed"
        message="La reprise du fil a échoué."
      />,
    );
    expect(status.getAttribute('aria-busy')).toBe('false');
    expect(status.textContent).toContain('échoué');
    cleanup();
  }
});
