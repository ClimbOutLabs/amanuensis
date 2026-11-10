import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import { providerLabel } from '../../utils/modelUsage.js';

/** Shown on a new chat once Incognito is chosen. */
export const PRIVATE_CHAT_CHOICE_LINE =
  'Aman forgets this chat when it closes. It can still read what it already knows.';

/** The Start incognito chat button's hover text. */
export const PRIVATE_CHAT_HOVER_LINE =
  'Start a chat Aman forgets. Nothing from it is saved, and it is deleted when you close it.';

/** Close and delete asks first, because nothing can bring the chat back. */
export const PRIVATE_CHAT_DELETE_WARNING =
  'Everything in this chat is deleted for good: every message, picture and file. It cannot be brought back.';

export const PRIVATE_CHAT_LOCAL_LINE = 'Nothing from this chat is kept. It never leaves this machine.';

/** Shown until the server says where the chat is answered. */
export const PRIVATE_CHAT_CHECKING_LINE = 'Nothing from this chat is kept here.';

/** A known provider reads by its brand name; anything else by the name it was given in Settings. */
function hostedName(provider: TrueForgeApi.HostedModelProvider): string {
  const label = providerLabel(provider.type);
  return label === provider.type || provider.type === 'custom' ? provider.name : label;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** The banner's one line: whether the chat's words leave this machine, and to whom. */
export function privateChatBannerLine(privacy: TrueForgeApi.ChatPrivacy | undefined): string {
  if (privacy === undefined) return PRIVATE_CHAT_CHECKING_LINE;
  if (!privacy.leavesMachine) return PRIVATE_CHAT_LOCAL_LINE;
  const names = [...new Set(privacy.hostedProviders.map(hostedName))];
  return `Nothing from this chat is kept here. It is answered by ${joinNames(names)}, so the words do leave this machine.`;
}
