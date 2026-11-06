/**
 * Skill network cards: the questions Aman asks when a skill wants the network.
 *
 * A card rides the held-action machinery as a held call whose card carries the question: the
 * skill, the sites, and why it is asked. The first time a skill with declared sites runs in a
 * chat with no approval in force, one card asks for the whole declared list; when the gateway
 * refuses a site the skill did not declare, one card asks for that site. The turn never waits
 * on a card: commands run without the grant meanwhile and the gateway refuses what is not
 * granted. Answering records the decision and re-runs the held command, like any held action.
 */
import type { Tier3Card, Tier3SkillNetwork } from './tier';

/** The three answers a network card takes. */
export type SkillNetworkAnswer = 'allow_once' | 'always_allow' | 'deny';

/** One card the host asks the runtime to raise, from a command's skill network outcome. */
export interface SkillNetworkCardRequest {
  skill_name: string;
  hosts: readonly string[];
  reason: Tier3SkillNetwork['reason'];
}

/** The answer an approval decision means for a network card: scope picks once versus always. */
export function skillNetworkAnswerFor(input: {
  status: 'allow' | 'deny';
  scope: 'once' | 'chat' | 'always' | undefined;
}): SkillNetworkAnswer {
  if (input.status === 'deny') {
    return 'deny';
  }
  return input.scope === 'always' ? 'always_allow' : 'allow_once';
}

/** The card for one network question, in plain words, with the question itself riding along. */
export function buildSkillNetworkCard(input: {
  skill_name: string;
  hosts: readonly string[];
  reason: Tier3SkillNetwork['reason'];
}): Tier3Card {
  const sites = input.hosts.join(', ');
  const skill_network: Tier3SkillNetwork = {
    skill_name: input.skill_name,
    hosts: [...input.hosts],
    reason: input.reason,
    code_pin: null,
  };
  if (input.reason === 'first_use') {
    return {
      plain_what: `Let the ${input.skill_name} skill reach ${sites}?`,
      plain_why: 'This skill names these sites as the ones it needs. It cannot reach any of them until you say yes.',
      cannot_be_undone: null,
      why_asked_again: null,
      destination: sites,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: null,
      destination_host: input.hosts.length === 1 ? (input.hosts[0] ?? null) : null,
      outbound_truncated: false,
      skill_network,
    };
  }
  return {
    plain_what: `Let the ${input.skill_name} skill reach ${sites}?`,
    plain_why: `The skill tried to reach ${sites}, which it did not name in advance, and the connection was refused.`,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: sites,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: input.hosts.length === 1 ? (input.hosts[0] ?? null) : null,
    outbound_truncated: false,
    skill_network,
  };
}
