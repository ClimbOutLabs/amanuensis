import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  hasSkillNetworkApproval,
  parseSkillNetworkApproval,
  skillNetworkApprovalLines,
  skillNetworkApprovedLine,
  type SkillNetworkApprovalState,
} from '@/server/skillNetworkApproval.js';

const TEN_X_STATE: SkillNetworkApprovalState = {
  declaredHosts: ['github.com', 'api.github.com'],
  approvedHosts: null,
  sendCapable: false,
};

describe('parseSkillNetworkApproval', () => {
  it('projects the wire shape onto the UI names', () => {
    assert.deepEqual(
      parseSkillNetworkApproval({
        data: {
          declared_hosts: ['gmail.googleapis.com'],
          approved_hosts: ['gmail.googleapis.com'],
          send_capable: true,
        },
      }),
      { declaredHosts: ['gmail.googleapis.com'], approvedHosts: ['gmail.googleapis.com'], sendCapable: true },
    );
  });

  it('throws a plain error on an unreadable body', () => {
    assert.throws(() => parseSkillNetworkApproval({ data: { nope: true } }), /unreadable response/);
  });
});

describe('hasSkillNetworkApproval', () => {
  it('is true only when all three calls are present', () => {
    assert.equal(
      hasSkillNetworkApproval({
        getSkillNetworkApproval: async () => TEN_X_STATE,
        approveSkillNetwork: async () => TEN_X_STATE,
        revokeSkillNetwork: async () => undefined,
      }),
      true,
    );
    assert.equal(hasSkillNetworkApproval({}), false);
    assert.equal(hasSkillNetworkApproval({ getSkillNetworkApproval: async () => TEN_X_STATE }), false);
  });
});

describe('the approval wording', () => {
  it('names the skill, states the chat grain, and warns that data can be sent', () => {
    const lines = skillNetworkApprovalLines({ skillName: 'ten-x', state: TEN_X_STATE });
    assert.equal(lines[0], 'The ten-x skill needs to reach these sites to work:');
    assert.ok(
      lines.some(line =>
        line.startsWith(
          'While this skill is switched on for a chat, that chat’s sandbox can contact these sites and no others.',
        ),
      ),
    );
    assert.ok(lines.some(line => line.includes('The skill can send any of your data to them')));
    // Nothing claims the traffic is inspected or checked.
    assert.ok(!lines.join(' ').toLowerCase().includes('inspect'));
    assert.ok(!lines.join(' ').toLowerCase().includes('monitor'));
  });

  it('adds the sending line only when a declared site can send', () => {
    const withoutSend = skillNetworkApprovalLines({ skillName: 'ten-x', state: TEN_X_STATE });
    assert.ok(!withoutSend.some(line => line.includes('send email as you')));
    const withSend = skillNetworkApprovalLines({
      skillName: 'google',
      state: { declaredHosts: ['gmail.googleapis.com'], approvedHosts: null, sendCapable: true },
    });
    assert.ok(
      withSend.includes(
        'One of these sites can send email. This skill will be able to send email as you, without asking each time.',
      ),
    );
  });

  it('the approved line says access is on and bounded to the listed sites', () => {
    assert.equal(
      skillNetworkApprovedLine(),
      'Network access is on for this skill. Chats using it can reach the sites above, and no others.',
    );
  });
});
