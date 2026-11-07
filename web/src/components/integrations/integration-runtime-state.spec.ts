import { expect, it } from 'vitest';
import {
  mcpOrigin,
  mcpConnection,
  appRuntimeState,
} from './integration-runtime-state';

it('classifies execution from effective transport configuration rather than a friendly name', () => {
  expect(mcpOrigin('unraid')).toBe('originUnknown');
  expect(mcpOrigin('unraid', { command: 'node' })).toBe('localProcess');
  expect(mcpOrigin('unraid', { url: 'https://unraid.example/mcp' })).toBe(
    'directRemote',
  );
  expect(mcpOrigin('codex_apps', { command: 'bridge' })).toBe('viaOpenAI');
  expect(mcpOrigin('local-agent', { command: ' ' })).toBe('originUnknown');
});
it('never infers a verified connection from an unknown runtime status', () => {
  expect(mcpConnection(null)).toBe('unverified');
  expect(mcpConnection(undefined)).toBe('unverified');
  expect(mcpConnection('ready')).toBe('unverified');
  expect(mcpConnection('connected')).toBe('connected');
  expect(mcpConnection('authenticationRequired')).toBe(
    'authenticationRequired',
  );
  expect(mcpConnection('failed')).toBe('failed');
});
it('requires runtime evidence rather than catalog availability to report usable app tools', () => {
  expect(appRuntimeState(false, true, true)).toBe('connectionUnverified');
  expect(appRuntimeState(true, true, true)).toBe('toolsAvailable');
  expect(appRuntimeState(true, true, false)).toBe('noCallableTools');
  expect(appRuntimeState(true, false, true)).toBe('runtimeDisabled');
});
