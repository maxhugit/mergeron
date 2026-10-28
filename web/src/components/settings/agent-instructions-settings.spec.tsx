import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AgentInstructionsSettings } from './agent-instructions-settings';
import { catalogFixture, deferred, json } from './catalog/catalog.testing';

let fixture: ReturnType<typeof catalogFixture>;
let value: string;
const path = '/api/settings/general.agentInstructions';
const agentInstructionsQueryKey = ['settings', 'general.agentInstructions'];
const defaultValue = 'Check desktop and mobile, then examine both images.';
const setting = () => ({
  key: 'general.agentInstructions',
  value,
  defaultValue,
  source: 'db',
});
beforeEach(() => {
  fixture = catalogFixture();
  value = defaultValue;
  fixture.server.overrides.set(`GET ${path}`, () => json(setting()));
  fixture.server.overrides.set(`PATCH ${path}`, async (request) => {
    const body = (await request.json()) as { value: string | null };
    value = body.value ?? defaultValue;
    return json(setting());
  });
});
afterEach(() => fixture.dispose());

it('loads only the common setting and saves the edited value through the real SDK', async () => {
  fixture.render(<AgentInstructionsSettings active />);
  const text = await screen.findByRole('textbox', {
    name: 'Common instructions text',
  });
  expect(text).toHaveValue(defaultValue);
  expect(text).toHaveAttribute('maxLength', '12000');
  expect(
    screen.getByRole('button', { name: 'Save common instructions' }),
  ).toBeDisabled();
  fireEvent.change(text, { target: { value: 'My instance policy' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Save common instructions' }),
  );
  await screen.findByText(/Instructions saved/);
  expect(fixture.server.writes).toEqual([
    { method: 'PATCH', path, body: { value: 'My instance policy' } },
  ]);
  expect(text).toHaveValue('My instance policy');
  expect(
    fixture.fetch.mock.calls.every(
      ([input]) => new URL((input as Request).url).pathname === path,
    ),
  ).toBe(true);
});

it('preserves dirty text through tab switches and background refetch; reset stages a draft before saving', async () => {
  value = 'Custom policy';
  const view = fixture.render(<AgentInstructionsSettings active />);
  const text = await screen.findByRole('textbox');
  fireEvent.change(text, { target: { value: 'Unsaved text' } });
  view.rerender(
    <QueryClientProvider client={fixture.queryClient}>
      <AgentInstructionsSettings active={false} />
    </QueryClientProvider>,
  );
  view.rerender(
    <QueryClientProvider client={fixture.queryClient}>
      <AgentInstructionsSettings active />
    </QueryClientProvider>,
  );
  value = 'Changed elsewhere';
  await fixture.queryClient.invalidateQueries({
    queryKey: agentInstructionsQueryKey,
  });
  expect(screen.getByRole('textbox')).toHaveValue('Unsaved text');
  fireEvent.click(screen.getByRole('button', { name: 'Restore default text' }));
  expect(text).toHaveValue(defaultValue);
  expect(fixture.server.writes).toHaveLength(0);
  fireEvent.click(
    screen.getByRole('button', { name: 'Save common instructions' }),
  );
  await screen.findByText(/Instructions saved/);
  expect(fixture.server.writes[0].body).toEqual({ value: null });
});

it('keeps an explicit empty value and preserves a failed draft until a successful retry', async () => {
  const response = deferred<Response>();
  fixture.server.overrides.set(`PATCH ${path}`, () => response.promise);
  fixture.render(<AgentInstructionsSettings active />);
  const text = await screen.findByRole('textbox');
  fireEvent.change(text, { target: { value: '' } });
  fireEvent.click(
    screen.getByRole('button', { name: 'Save common instructions' }),
  );
  await waitFor(() => expect(text).toBeDisabled());
  response.resolve(json({ message: 'Disk unavailable' }, 500));
  await screen.findByRole('alert');
  expect(text).toHaveValue('');
  fixture.server.overrides.set(`PATCH ${path}`, () =>
    json({ ...setting(), value: '' }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Save common instructions' }),
  );
  await screen.findByText(/Instructions saved/);
  expect(fixture.server.writes.at(-1)?.body).toEqual({ value: '' });
});

it('does not replace a failed load with blank editable text and permits retry', async () => {
  fixture.server.overrides.set(`GET ${path}`, () => json({}, 503));
  fixture.render(<AgentInstructionsSettings active />);
  await screen.findByRole('alert');
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fixture.server.overrides.set(`GET ${path}`, () => json(setting()));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('textbox')).toHaveValue(defaultValue);
});
