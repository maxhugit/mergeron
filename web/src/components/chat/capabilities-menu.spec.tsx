import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CapabilitiesMenu } from './capabilities-menu';

vi.mock('./mcp-status-badge', () => ({
  McpStatusBadge: () => <button>Connectors</button>,
}));

vi.mock('./skill-selector', () => ({
  SkillSelector: () => <button>Skills</button>,
}));

vi.mock('./service-tier-selector', () => ({
  ServiceTierSelector: () => <button>Speed</button>,
}));
vi.mock('./response-detail-selector', () => ({
  ResponseDetailSelector: () => <select aria-label="Response detail" />,
}));

describe('CapabilitiesMenu', () => {
  it('groups connectors, skills and speed behind one composer control', () => {
    render(<CapabilitiesMenu cwd="/workspaces/demo" onSelectSkill={vi.fn()} />);

    expect(screen.queryByText('Connectors')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Chat controls' }));

    expect(
      screen.getByRole('button', { name: 'Connectors' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speed' })).toBeInTheDocument();
    expect(
      screen.getByRole('combobox', { name: 'Response detail' }),
    ).toBeInTheDocument();
  });
});
