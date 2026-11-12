import { BrowserElementReviewSchema, type BrowserElementReview } from '../../../src/core/llm/LLMTypes';
import {
  BROWSER_CANCEL_QUALIFIERS,
  BROWSER_COMMIT_WORDS,
  classifyBrowserClickKind,
  matchesCommitWord,
  sameBrowserElementReview,
} from '../../../src/core/permissions/browserTier';
import {
  BROWSER_CLICK_TOOL_NAME,
  BROWSER_SELECT_TOOL_NAME,
  BROWSER_TYPE_TOOL_NAME,
} from '../../../src/core/permissions/browserToolNames';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function browserAction(tool_name: string, extra: Partial<SentinelAction> = {}): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_hints: { read_only_hint: true, open_world_hint: true },
    ...extra,
  };
}

function clickReview(overrides: Partial<BrowserElementReview> = {}): BrowserElementReview {
  return {
    site: 'shop.example',
    accessible_name: 'Cancel',
    role: 'button',
    is_form_submit: false,
    form_values: {},
    link_url: null,
    ...overrides,
  };
}

describe('matchesCommitWord: each commit word on its own', () => {
  it.each(BROWSER_COMMIT_WORDS)('"%s" matches', word => {
    expect(matchesCommitWord(`${word[0]?.toUpperCase()}${word.slice(1)}`)).toBe(true);
    expect(matchesCommitWord(`Please ${word} now`)).toBe(true);
  });

  it('a commit word must be a whole word, not a fragment of another', () => {
    expect(matchesCommitWord('Sender')).toBe(false); // contains "send", but is not the word "send"
    expect(matchesCommitWord('Submitted applications')).toBe(false); // contains "submit", but is not the word "submit"
  });

  it('matches the two-word "sign up" phrase', () => {
    expect(matchesCommitWord('Sign up')).toBe(true);
    expect(matchesCommitWord('Sign-up now')).toBe(true);
  });

  it('matches every commit word spelled out here, so dropping one from the list fails', () => {
    // Written out on purpose, not read from the exported list: a test that iterates the list
    // stays green when a word is dropped from it.
    for (const label of [
      'Pay',
      'Buy',
      'Purchase',
      'Order',
      'Checkout',
      'Confirm',
      'Submit',
      'Send',
      'Delete',
      'Remove',
      'Unsubscribe',
      'Subscribe',
      'Transfer',
      'Book',
      'Reserve',
      'Accept',
      'Agree',
      'Sign up',
    ]) {
      expect(matchesCommitWord(label)).toBe(true);
      expect(matchesCommitWord(`Please ${label.toLowerCase()} now`)).toBe(true);
    }
  });

  it('matches "check out" in each of its spellings, the spaced form of the checkout word', () => {
    for (const label of ['Check out', 'Check-out', 'check_out', 'CHECK OUT', 'Check Out Now', 'Please check out now']) {
      expect(matchesCommitWord(label)).toBe(true);
    }
  });

  it('neither half of "check out" matches on its own, and neither do unrelated words', () => {
    for (const label of ['Check', 'Out', 'Out of stock', 'Check our prices', 'Check outerwear', 'Look out']) {
      expect(matchesCommitWord(label)).toBe(false);
    }
  });

  it('plain links, tabs and menus do not match', () => {
    for (const label of ['Help center', 'Account settings', 'Show more', 'Next', 'Learn more', 'FAQ']) {
      expect(matchesCommitWord(label)).toBe(false);
    }
  });
});

describe('matchesCommitWord: "cancel" needs what it cancels', () => {
  it('bare "Cancel" does not match: a dialog\'s own close button', () => {
    expect(matchesCommitWord('Cancel')).toBe(false);
  });

  it.each(BROWSER_CANCEL_QUALIFIERS)('"Cancel %s" matches', qualifier => {
    expect(matchesCommitWord(`Cancel ${qualifier}`)).toBe(true);
    expect(matchesCommitWord(`Cancel your ${qualifier}`)).toBe(true);
  });

  it('matches "cancel" with each qualifier spelled out here, so dropping one from the list fails', () => {
    // Written out on purpose, not read from the exported list, for the same reason as the words above.
    for (const label of [
      'Cancel membership',
      'Cancel subscription',
      'Cancel plan',
      'Cancel order',
      'Cancel account',
      'Cancel your membership',
      'Cancel your subscription',
      'Cancel your plan',
      'Cancel your order',
      'Cancel your account',
    ]) {
      expect(matchesCommitWord(label)).toBe(true);
    }
  });

  it('"Cancel" near an unrelated word still does not match', () => {
    expect(matchesCommitWord('Cancel search')).toBe(false);
    expect(matchesCommitWord('Cancel this dialog')).toBe(false);
  });
});

const LINK = 'https://shop.example/help';

describe('classifyBrowserClickKind', () => {
  it('any form submit asks, whatever its label, even when it is a link', () => {
    expect(classifyBrowserClickKind({ accessible_name: 'Go', is_form_submit: true, link_url: null })).toBe(
      'form_submit',
    );
    expect(classifyBrowserClickKind({ accessible_name: 'Go', is_form_submit: true, link_url: LINK })).toBe(
      'form_submit',
    );
  });

  it('a button asks whatever its label, in any language, or with no label at all', () => {
    for (const label of ['Show details', 'Next page', 'Cancel', 'Jetzt bezahlen', 'Comprar', '支付', 'OK', 'Yes', '']) {
      expect(classifyBrowserClickKind({ accessible_name: label, is_form_submit: false, link_url: null })).toBe(
        'not_a_link',
      );
    }
  });

  it('a plain link with a commit word asks', () => {
    for (const label of ['Buy now', 'Check out', 'Check-out', 'check_out', 'Cancel membership']) {
      expect(classifyBrowserClickKind({ accessible_name: label, is_form_submit: false, link_url: LINK })).toBe(
        'commit_word',
      );
    }
  });

  it('a commit word hidden with characters that show nothing still asks', () => {
    for (const label of ['Pa\u200By now', 'De\u00ADlete', 'Sub\u200Dmit', '\uFF30ay now', 'Se\u2060nd']) {
      expect(classifyBrowserClickKind({ accessible_name: label, is_form_submit: false, link_url: LINK })).toBe(
        'commit_word',
      );
    }
  });

  it('only a plain link with an ordinary label runs without asking', () => {
    for (const label of ['Help center', 'Pricing', 'Show more', 'Next page']) {
      expect(classifyBrowserClickKind({ accessible_name: label, is_form_submit: false, link_url: LINK })).toBe(
        'explore',
      );
    }
  });

  it('the commit word list never lets a button through', () => {
    // Labels with no commit word: a button still asks, because the list only ever adds asking.
    expect(classifyBrowserClickKind({ accessible_name: 'Pricing', is_form_submit: false, link_url: null })).not.toBe(
      'explore',
    );
  });
});

describe('classifyTier: browser_type and browser_select ask first, showing the exact text', () => {
  const field = clickReview({ accessible_name: 'Name', role: 'textbox', site: 'shop.example' });

  it('typing into a field asks, with the text, the field and the site on the card', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_TYPE_TOOL_NAME, { browser_element: field, canonical_params: { ref: 'e1', text: 'Grace' } }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'browser_prepare' });
    expect(decision.card?.plain_what).toBe('Type "Grace" into "Name" on shop.example?');
    expect(decision.card?.destination_host).toBe('shop.example');
    expect(decision.card?.outbound_text).toContain('Grace');
    expect(decision.approval_token_id).toEqual(expect.any(String));
  });

  it('a long text or label is cut short in the headline and shown whole in the detail', async () => {
    const long = 'x'.repeat(200);
    const decision = await classifyTier(
      browserAction(BROWSER_TYPE_TOOL_NAME, {
        browser_element: { ...field, accessible_name: 'y'.repeat(200) },
        canonical_params: { ref: 'e1', text: long },
      }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toBe(`Type "${'x'.repeat(60)}…" into "${'y'.repeat(60)}…" on shop.example?`);
    expect(decision.card?.outbound_text).toContain(long);
  });

  it('picking an option asks, with the option on the card', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_SELECT_TOOL_NAME, {
        browser_element: field,
        canonical_params: { ref: 'e2', option: 'Premium' },
      }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'browser_prepare' });
    expect(decision.card?.plain_what).toBe('Pick "Premium" in "Name" on shop.example?');
    expect(decision.card?.outbound_text).toContain('Premium');
  });
});

describe('classifyTier: an action whose element could not be read is refused before any card', () => {
  for (const tool of [BROWSER_TYPE_TOOL_NAME, BROWSER_SELECT_TOOL_NAME, BROWSER_CLICK_TOOL_NAME]) {
    it(`${tool} with no read of its element`, async () => {
      const decision = await classifyTier(browserAction(tool), makeCtx());
      expect(decision).toMatchObject({ tier: 3, card: null, reason: 'auto_denied', auto_deny: 'tool_not_prepared' });
      expect(decision.reason_detail).toMatch(/could not read that part of the page first/);
    });
  }
});

describe('sameBrowserElementReview', () => {
  const read = clickReview({ accessible_name: 'Keep my plan', form_values: { plan: 'basic', seats: '2' } });

  it('the same read in any field order matches', () => {
    expect(sameBrowserElementReview({ a: read, b: { ...read, form_values: { seats: '2', plan: 'basic' } } })).toBe(
      true,
    );
  });

  it('a difference in any one field does not', () => {
    for (const change of [
      { site: 'other.example' },
      { accessible_name: 'Cancel membership' },
      { role: 'link' },
      { is_form_submit: true },
      { link_url: 'https://shop.example/x' },
      { form_values: { plan: 'basic' } },
      { form_values: { plan: 'premium', seats: '2' } },
    ]) {
      expect(sameBrowserElementReview({ a: read, b: { ...read, ...change } })).toBe(false);
    }
  });
});

describe('classifyTier: browser_click', () => {
  it('a form submit asks first, with a card naming the site, the button and the form values', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_element: clickReview({
          accessible_name: 'Place order',
          is_form_submit: true,
          site: 'shop.example',
          form_values: { card_last4: '4242' },
        }),
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('browser_commit');
    expect(decision.card?.plain_what).toBe('Click "Place order" on shop.example?');
    expect(decision.card?.copy).toEqual({
      headline: 'Click "Place order" on shop.example?',
      consequence: null,
      reason: null,
    });
    expect(decision.card?.outbound_text).toContain('card_last4');
    expect(decision.approval_token_id).toEqual(expect.any(String));
  });

  it('a link with a commit word also asks first', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_element: clickReview({ accessible_name: 'Unsubscribe', is_form_submit: false, link_url: LINK }),
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('browser_commit');
  });

  it('a plain link runs without asking', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_element: clickReview({ accessible_name: 'Help center', is_form_submit: false, link_url: LINK }),
      }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, card: null, reason: 'browser_explore' });
  });

  it('a button that is not in a form asks first, with a card, whatever its label', async () => {
    for (const label of ['Show details', 'Jetzt bezahlen', '']) {
      const decision = await classifyTier(
        browserAction(BROWSER_CLICK_TOOL_NAME, {
          browser_element: clickReview({ accessible_name: label, is_form_submit: false }),
        }),
        makeCtx(),
      );
      expect(decision.tier).toBe(3);
      expect(decision.reason).toBe('browser_commit');
      expect(decision.reason_detail).toMatch(/whatever its label says/);
      expect(decision.approval_token_id).toEqual(expect.any(String));
    }
  });

  it('an unlabelled button names itself as having no label on the card', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_element: clickReview({ accessible_name: '', is_form_submit: false }),
      }),
      makeCtx(),
    );
    expect(decision.card?.plain_what).toBe('Click "(no label)" on shop.example?');
  });

  it('a stored read from before links were told apart counts as not a link, so it asks', async () => {
    const stored = BrowserElementReviewSchema.parse({
      role: 'link',
      site: 'shop.example',
      accessible_name: 'Help center',
      is_form_submit: false,
      form_values: {},
    });
    expect(stored.link_url).toBeNull();
    const decision = await classifyTier(browserAction(BROWSER_CLICK_TOOL_NAME, { browser_element: stored }), makeCtx());
    expect(decision.tier).toBe(3);
  });

  it('"Cancel membership" on a link always asks', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_element: clickReview({ accessible_name: 'Cancel membership', is_form_submit: false, link_url: LINK }),
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('browser_commit');
  });
});
