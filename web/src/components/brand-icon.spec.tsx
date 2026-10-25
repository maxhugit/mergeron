import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { BrandIcon } from './brand-icon';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.mergeronEnvironment;
});

it('keeps production copper and selects the dev logo only from runtime environment metadata', () => {
  const { rerender, container } = render(<BrandIcon />);
  expect(container.querySelector('img')).toHaveAttribute(
    'src',
    '/mergeron-icon.svg',
  );
  document.documentElement.dataset.mergeronEnvironment = 'development';
  rerender(<BrandIcon className="dev-test" />);
  expect(container.querySelector('img')).toHaveAttribute(
    'src',
    '/mergeron-dev-icon.svg',
  );
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
