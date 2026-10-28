import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { GitInspectionError } from './git-inspection-error';

it.each([
  ['GIT_OUTPUT_LIMIT_EXCEEDED', '1 MiB limit'],
  ['GIT_COMMAND_TIMEOUT', 'within the allowed time'],
  ['private-token-and-path', 'Unable to inspect this copy'],
])('explains %s without displaying raw diagnostics', (code, expected) => {
  render(<GitInspectionError error={new Error(code)} />);
  expect(screen.getByRole('alert')).toHaveTextContent(expected);
  expect(screen.getByRole('alert')).not.toHaveTextContent(code);
});
