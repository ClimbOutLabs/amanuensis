import type { BrowserClickReview } from '../../../src/core/llm/LLMTypes';
import {
  BROWSER_CANCEL_QUALIFIERS,
  BROWSER_COMMIT_WORDS,
  classifyBrowserClickKind,
  matchesCommitWord,
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

function clickReview(overrides: Partial<BrowserClickReview> = {}): BrowserClickReview {
  return {
    site: 'shop.example',
    accessible_name: 'Cancel',
    is_form_submit: false,
    form_values: {},
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

  it('"Cancel" near an unrelated word still does not match', () => {
    expect(matchesCommitWord('Cancel search')).toBe(false);
    expect(matchesCommitWord('Cancel this dialog')).toBe(false);
  });
});

describe('classifyBrowserClickKind', () => {
  it('any form submit is a commit, whatever its label', () => {
    expect(classifyBrowserClickKind({ accessible_name: 'Go', is_form_submit: true })).toBe('commit');
  });

  it('a commit word is a commit even outside a form', () => {
    expect(classifyBrowserClickKind({ accessible_name: 'Buy now', is_form_submit: false })).toBe('commit');
  });

  it('a link, a tab or "show more" is explore', () => {
    for (const label of ['Help center', 'Pricing', 'Show more', 'Next page']) {
      expect(classifyBrowserClickKind({ accessible_name: label, is_form_submit: false })).toBe('explore');
    }
  });

  it("a dialog's plain Cancel button, which closes without a request, is explore", () => {
    expect(classifyBrowserClickKind({ accessible_name: 'Cancel', is_form_submit: false })).toBe('explore');
  });
});

describe('classifyTier: browser_type and browser_select are Tier 1', () => {
  it('typing into a field asks nothing', async () => {
    const decision = await classifyTier(browserAction(BROWSER_TYPE_TOOL_NAME), makeCtx());
    expect(decision).toMatchObject({ tier: 1, card: null, reason: 'browser_prepare' });
  });

  it('picking an option asks nothing', async () => {
    const decision = await classifyTier(browserAction(BROWSER_SELECT_TOOL_NAME), makeCtx());
    expect(decision).toMatchObject({ tier: 1, card: null, reason: 'browser_prepare' });
  });
});

describe('classifyTier: browser_click', () => {
  it('a form submit asks first, with a card naming the site, the button and the form values', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_click: clickReview({
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
    expect(decision.card?.outbound_text).toContain('card_last4');
    expect(decision.approval_token_id).toEqual(expect.any(String));
  });

  it('a commit word outside a form also asks first', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_click: clickReview({ accessible_name: 'Unsubscribe', is_form_submit: false }),
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('browser_commit');
  });

  it('a link or a tab runs without asking', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_click: clickReview({ accessible_name: 'Help center', is_form_submit: false }),
      }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, card: null, reason: 'browser_explore' });
  });

  it("a dialog's plain Cancel button runs without asking", async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_click: clickReview({ accessible_name: 'Cancel', is_form_submit: false }),
      }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, card: null, reason: 'browser_explore' });
  });

  it('"Cancel membership" always asks, unlike a plain Cancel', async () => {
    const decision = await classifyTier(
      browserAction(BROWSER_CLICK_TOOL_NAME, {
        browser_click: clickReview({ accessible_name: 'Cancel membership', is_form_submit: false }),
      }),
      makeCtx(),
    );
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('browser_commit');
  });

  it('fails closed to the generic Tier 3 path when the host could not read the click context', async () => {
    const decision = await classifyTier(browserAction(BROWSER_CLICK_TOOL_NAME), makeCtx());
    expect(decision.tier).toBe(3);
  });
});
