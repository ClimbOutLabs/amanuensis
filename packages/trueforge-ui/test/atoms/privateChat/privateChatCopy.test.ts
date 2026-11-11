import { describe, expect, it } from 'vitest';

import {
  PRIVATE_CHAT_CHECKING_LINE,
  PRIVATE_CHAT_LOCAL_LINE,
  privateChatBannerLine,
} from '@/atoms/privateChat/privateChatCopy.js';

describe('privateChatBannerLine', () => {
  it('says the words never leave when every model is on this machine', () => {
    expect(privateChatBannerLine({ leavesMachine: false, hostedProviders: [] })).toBe(
      'Nothing from this chat is kept. It never leaves this machine.',
    );
    expect(PRIVATE_CHAT_LOCAL_LINE).toBe('Nothing from this chat is kept. It never leaves this machine.');
  });

  it('names a known hosted provider by its brand', () => {
    expect(
      privateChatBannerLine({ leavesMachine: true, hostedProviders: [{ type: 'anthropic', name: 'my-claude' }] }),
    ).toBe('Nothing from this chat is kept here. It is answered by Anthropic, so the words do leave this machine.');
  });

  it('names a custom provider by the name it was given, and joins several', () => {
    expect(
      privateChatBannerLine({
        leavesMachine: true,
        hostedProviders: [
          { type: 'tokenfactory', name: 'tokenfactory' },
          { type: 'custom', name: 'Office GPU box' },
          { type: 'anthropic', name: 'anthropic' },
        ],
      }),
    ).toBe(
      'Nothing from this chat is kept here. It is answered by Token Factory, Office GPU box and Anthropic, so the words do leave this machine.',
    );
  });

  it('claims nothing about where the words go before the server answers', () => {
    expect(privateChatBannerLine(undefined)).toBe(PRIVATE_CHAT_CHECKING_LINE);
  });
});
