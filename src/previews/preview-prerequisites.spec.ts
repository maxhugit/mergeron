import { describe, expect, it } from 'vitest';
import { previewConfigurationPrerequisites } from './preview-prerequisites';
import contract from '../../runtime/preview-profile.cjs';
const input = {
  platformEnabled: true,
  domain: 'preview.example.org',
  viewerReady: true,
  capabilities: {
    enabled: true,
    domain: 'preview.example.org',
    runtimes: [{ id: 'node' }],
  },
  profile: contract.profile({
    enabled: true,
    runtime: 'node',
    start: 'node server.js',
  }),
  profileConfigured: true,
};
describe('deployment prerequisites from the Manager', () => {
  it('keeps old Managers compatible and forwards bounded public reason codes', () => {
    expect(previewConfigurationPrerequisites(input).reasons).toEqual([]);
    expect(
      previewConfigurationPrerequisites({
        ...input,
        capabilities: {
          ...input.capabilities,
          prerequisites: [
            'application_identity_invalid',
            'runtime_image_missing',
          ],
        },
      }).reasons,
    ).toEqual(['application_identity_invalid', 'runtime_image_missing']);
  });
  it('fails closed without reflecting arbitrary Docker error details', () => {
    for (const prerequisites of [
      'private error',
      ['private secret error'],
      [null],
    ]) {
      expect(
        previewConfigurationPrerequisites({
          ...input,
          capabilities: { ...input.capabilities, prerequisites },
        }).reasons,
      ).toEqual(['manager_preflight_failed']);
    }
  });
});
