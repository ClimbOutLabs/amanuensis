// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ToolCallCard } from '@/atoms/ToolCallCard.js';

describe('ToolCallCard MCP label', () => {
  it('renders `innerTool · server` when a server name is present', () => {
    render(<ToolCallCard toolName="list_teams" mcpServerName="linear" dataTestPrefix="mcp" />);

    expect(screen.getByTestId('mcp-header-title')).toHaveTextContent('list_teams · linear');
    expect(screen.getByTitle('list_teams')).toHaveTextContent('list_teams · linear');
  });

  it('renders the raw tool name alone when no server name is present', () => {
    render(<ToolCallCard toolName="exec" dataTestPrefix="plain" />);

    expect(screen.getByTestId('plain-header-title')).toHaveTextContent('exec');
    expect(screen.queryByText('·')).not.toBeInTheDocument();
  });

  it('derives the friendly label from the MCP meta-tool display form', () => {
    render(<ToolCallCard toolName="call_tool: list_teams (linear)" mcpServerName="linear" dataTestPrefix="meta" />);

    expect(screen.getByTestId('meta-header-title')).toHaveTextContent('list_teams · linear');
    expect(screen.getByTitle('call_tool: list_teams (linear)')).toHaveTextContent('list_teams · linear');
  });
});
