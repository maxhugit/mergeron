import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { TooltipProvider } from '@/components/ui/tooltip';
import { CopyResponse } from './copy-response';
import i18n, { i18nReady } from '@/i18n';
import '@/index.css';

afterEach(cleanup);

test('reveals only the hovered response icon at the top right, with a tooltip and keyboard access', async () => {
  await page.viewport(1000, 700);
  await i18nReady;
  await i18n.changeLanguage('fr');
  render(
    <TooltipProvider>
      <div className="group space-y-8 p-8">
        <p>En dehors des réponses</p>
        <CopyResponse completed empty={false}>
          <p>Première réponse</p>
        </CopyResponse>
        <CopyResponse completed empty={false}>
          <p>Deuxième réponse</p>
        </CopyResponse>
      </div>
    </TooltipProvider>,
  );
  const [first, second] = screen.getAllByRole('button', {
    name: 'Copier avec mise en forme',
  });
  await page.getByText('En dehors des réponses').hover();
  expect(first.textContent).toBe('');
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    await expect.poll(() => getComputedStyle(first).opacity).toBe('0');
    await expect.poll(() => getComputedStyle(second).opacity).toBe('0');
  }
  await page.getByText('Première réponse', { exact: true }).hover();
  await expect.poll(() => getComputedStyle(first).opacity).toBe('1');
  if (matchMedia('(hover: hover) and (pointer: fine)').matches)
    expect(getComputedStyle(second).opacity).toBe('0');
  const frame = first.closest('.group\\/response')!.getBoundingClientRect();
  const icon = first.getBoundingClientRect();
  expect(Math.abs(icon.right - frame.right)).toBeLessThan(1);
  expect(Math.abs(icon.top - frame.top)).toBeLessThan(1);
  await page
    .getByRole('button', { name: 'Copier avec mise en forme' })
    .nth(0)
    .hover();
  await expect
    .poll(() => screen.queryByRole('tooltip')?.textContent)
    .toBe('Copier avec mise en forme');
  await page.getByText('En dehors des réponses').hover();
  second.focus();
  await expect.poll(() => getComputedStyle(second).opacity).toBe('1');
});
