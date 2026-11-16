import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { allowsChatApproval, allowsToolGrant } from '../../../src/core/mcp/approvalGrant';
import { stampSentinelDecision } from '../../../src/core/mcp/ToolSet';
import { tier3Decision, type TierDecision } from '../../../src/core/permissions/tier';

function haChangeDecision(grant_tool_name: string | null): TierDecision {
  return tier3Decision({
    card: {
      plain_what: 'Turn off Living room lamp',
      copy: null,
      plain_why: null,
      cannot_be_undone: null,
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: 'entity_id: light.living_room_lamp',
      destination_host: null,
      outbound_truncated: false,
    },
    reason: 'home_assistant_change',
    reason_detail: 'A change to your home asks first.',
    sensitive_read: false,
    approval_token_id: 'token-1',
    grant_binding: 'binding-home-assistant',
    grant_tool_name,
  });
}

function stampedInfo(decision: TierDecision): InternalToolCallInfo {
  return {
    type: 'mcp',
    mcp_server_id: 'home-assistant',
    mcp_server_name: 'home-assistant',
    original_tool_name: 'HassTurnOff',
    ...stampSentinelDecision({ decision }),
  };
}

describe('Home Assistant standing grant eligibility', () => {
  it('stamps the scope key onto the call and lets the person always allow it', () => {
    const info = stampedInfo(haChangeDecision('ha:domain:light'));
    expect(info.grant_tool_name).toBe('ha:domain:light');
    expect(info.is_approval_required).toBe(true);
    expect(allowsToolGrant(info)).toBe(true);
  });

  it('offers no standing grant when the call names no domain or entity', () => {
    const info = stampedInfo(haChangeDecision(null));
    expect(info.grant_tool_name).toBeUndefined();
    expect(allowsToolGrant(info)).toBe(false);
  });

  it('never offers a chat-wide grant for a home change', () => {
    const info = stampedInfo(haChangeDecision('ha:domain:light'));
    expect(allowsChatApproval(info)).toBe(false);
  });
});
