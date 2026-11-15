/**
 * Skill network cards: the questions Aman asks when a skill wants the network.
 *
 * A card rides the held-action machinery as a held call whose card carries the question: the
 * skill, the sites, and why it is asked. The first time a skill with declared sites runs in a
 * chat with no approval in force, one card asks for the declared sites still missing; when the gateway
 * refuses a site the skill did not declare, one card asks for that site. The turn never waits
 * on a card: commands run without the grant meanwhile and the gateway refuses what is not
 * granted. Answering records the decision and re-runs the held command, like any held action,
 * unless the command needs an approval of its own: then the re-run is refused and the command
 * is asked about on its own card, and only the answer about the sites is kept.
 *
 * A first-use card names its skill because the sites come from that skill's own declaration.
 * A card for a refused site names no skill: the gateway sees only the chat's combined grant,
 * so which skill, if any, reached for the site cannot be told, and the card says so instead of
 * blaming the skill the answer is filed under.
 */
import { domainToUnicode } from 'node:url';
import { simpleCardCopy } from './cardCopy';
import type { Tier3Card, Tier3SkillNetwork } from './tier';

/**
 * A site name as a person reads it. Names are stored and matched in their coded form. When the
 * decoded name differs, both are shown, because a decoded name can mix alphabets to pass for a
 * familiar site while the coded form cannot.
 */
function displaySiteName(host: string): string {
  const decoded = domainToUnicode(host);
  return decoded === '' || decoded === host.toLowerCase() ? host : `${decoded} (${host})`;
}

/** Points the reader at the coded name when a card shows one, so a look-alike name is caught. */
function codedNameNote(hosts: readonly string[]): string {
  return hosts.some(host => displaySiteName(host) !== host)
    ? ' The name in brackets is how the site is really written. Check it, because letters from another alphabet can make a site look like a familiar one.'
    : '';
}

/** The three answers a network card takes. */
export type SkillNetworkAnswer = 'allow_once' | 'always_allow' | 'deny';

/** One card the host asks the runtime to raise, from a command's skill network outcome. */
export interface SkillNetworkCardRequest {
  skill_name: string;
  hosts: readonly string[];
  reason: Tier3SkillNetwork['reason'];
  /** The code version the asked approval would cover, or null when no pin is in force. */
  code_pin: string | null;
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
  code_pin: string | null;
}): Tier3Card {
  const sites = input.hosts.map(displaySiteName).join(', ');
  const skill_network: Tier3SkillNetwork = {
    skill_name: input.skill_name,
    hosts: [...input.hosts],
    reason: input.reason,
    code_pin: input.code_pin,
  };
  const singleSite = input.hosts.length === 1 ? displaySiteName(input.hosts[0] ?? '') : null;
  if (input.reason === 'code_changed') {
    const plain_what = `Let the ${input.skill_name} skill reach ${sites}?`;
    return {
      plain_what,
      copy: simpleCardCopy({ headline: plain_what, undo: null, reason: null }),
      plain_why: `This skill\u2019s code changed since you approved it, so the approval was cancelled. Approving again covers the code as it is now.${codedNameNote(input.hosts)}`,
      cannot_be_undone: null,
      why_asked_again: null,
      destination: sites,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: null,
      destination_host: singleSite,
      outbound_truncated: false,
      skill_network,
    };
  }
  if (input.reason === 'first_use') {
    const plain_what = `Let the ${input.skill_name} skill reach ${sites}?`;
    return {
      plain_what,
      copy: simpleCardCopy({ headline: plain_what, undo: null, reason: null }),
      plain_why: `This skill names these sites as the ones it needs. It cannot reach any of them until you say yes.${codedNameNote(input.hosts)}`,
      cannot_be_undone: null,
      why_asked_again: null,
      destination: sites,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: null,
      destination_host: singleSite,
      outbound_truncated: false,
      skill_network,
    };
  }
  const plain_what = `Allow a connection to ${sites} in this chat?`;
  return {
    plain_what,
    copy: simpleCardCopy({ headline: plain_what, undo: null, reason: null }),
    plain_why: `A command in this chat tried to reach ${sites}, which is not one of the sites approved for the skills in this chat, and the connection was refused. Aman cannot tell which skill, if any, made the attempt.${codedNameNote(input.hosts)}`,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: sites,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: singleSite,
    outbound_truncated: false,
    skill_network,
  };
}
