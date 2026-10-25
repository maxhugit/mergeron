import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { page } from 'vitest/browser';
import { DeliverablesList } from './project-deliverables-manager';
import type { Deliverable, DeliverablesBoard } from '@/lib/deliverables-api';
import '@/index.css';
import { i18nReady } from '@/i18n';

afterEach(cleanup);
const item = {
  id: 'report',
  title: 'Dossier de conception',
  description: 'Description du livrable',
  lifecycleStatus: 'draft',
  validationStatus: 'not_required',
  validationRequired: false,
  confidentiality: 'restricted',
  primaryTaskId: null,
  updatedAt: Date.UTC(2026, 9, 25),
  documents: [
    { id: 'first', name: 'Dossier de conception.docx', deletedAt: null },
    {
      id: 'second',
      name: 'Présentation des choix de conception et des arbitrages.pptx',
      deletedAt: null,
    },
  ],
} as Deliverable;
const board = {
  tasks: [],
  resource: { projectId: 'project' },
} as unknown as DeliverablesBoard;

test.each([390, 800, 1001, 1280])(
  'keeps badges aligned and names responsive at %ipx',
  async (width) => {
    await page.viewport(width, 900);
    await i18nReady;
    render(
      <div style={{ width: '100%', padding: 16 }}>
        <DeliverablesList items={[item]} board={board} onSelect={() => {}} />
      </div>,
    );
    const status = screen.getByTestId('deliverable-status-report');
    const row = status.parentElement!;
    const badgeElements = Array.from(row.children).filter((element) =>
      element.classList.contains('justify-self-end'),
    );
    const bounds = badgeElements.map((element) =>
      element.getBoundingClientRect(),
    );
    expect(bounds).toHaveLength(3);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const names = row.querySelector('ul')!;
    if (width < 576) expect(getComputedStyle(names).display).toBe('none');
    else expect(getComputedStyle(names).display).not.toBe('none');
    if (width < 1120) {
      expect(Math.abs(bounds[0].right - bounds[1].right)).toBeLessThan(1);
      expect(Math.abs(bounds[1].right - bounds[2].right)).toBeLessThan(1);
      expect(bounds[0].top).toBeLessThan(bounds[1].top);
      expect(bounds[1].top).toBeLessThan(bounds[2].top);
    } else {
      expect(Math.abs(bounds[0].top - bounds[1].top)).toBeLessThan(1);
      expect(Math.abs(bounds[1].top - bounds[2].top)).toBeLessThan(1);
    }
  },
);
