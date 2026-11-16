import { isDriveReadToolName, isDriveWriteToolName } from '../drive/toolContract';
import type { DriveWriteReview } from '../drive/writeReview';
import { simpleCardCopy } from './cardCopy';
import { cardSubject, plainWhy } from './cardText';
import { escapeDisplayText } from './displayText';
import { hasReadContent } from './provenance';
import { withHoldSay } from './searchHoldText';
import {
  autoDenyDecision,
  CONTENT_STEERED_REASON,
  failClosedDecision,
  tier1Decision,
  tier3Decision,
  type Tier3Card,
  type TierDecision,
} from './tier';
import { hasStandingToolGrant, mintPlainToken, steeredSkipped } from './tierShared';
import type { ClassifyContext, SentinelAction } from './tierTypes';
import { TOOL_GRANT_REASON } from './toolGrants';

/**
 * The approval card for a Drive write, built from the write the host will really make, never from model
 * prose: a create shows its whole text, an append shows every row.
 */
function driveWriteCard(input: { review: DriveWriteReview; agent_intent: string | null }): Tier3Card {
  const { review } = input;
  const base = {
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    destination_host: null,
  };
  if (review.action === 'create_doc') {
    const headline = `Create a Google Doc named ${cardSubject(review.file_name)} in your Google Drive?`;
    return {
      ...base,
      plain_what: `${headline}${review.text === '' ? ' It starts empty.' : ''}`,
      copy: simpleCardCopy({ headline, undo: null, reason: null }),
      outbound_text: review.text === '' ? null : escapeDisplayText(review.text, { keepNewlines: true }),
    };
  }
  const rows = review.rows.map(row => row.map(cell => escapeDisplayText(cell)).join(', ')).join('\n');
  const sharing =
    review.shared_with === null
      ? ' This file is shared with other people.'
      : review.shared_with > 0
        ? ` This file is shared with ${String(review.shared_with)} ${review.shared_with === 1 ? 'person' : 'people'}.`
        : '';
  const headline = `Add ${String(review.rows.length)} ${review.rows.length === 1 ? 'row' : 'rows'} to the tab "${escapeDisplayText(review.sheet_name ?? '')}" of the Google Sheet ${cardSubject(review.file_name)}?`;
  return {
    ...base,
    plain_what: `${headline}${sharing}`,
    copy: simpleCardCopy({ headline, undo: null, reason: null }),
    outbound_text: rows,
  };
}

/**
 * Drive tools are the host's own, named by server so a connector's tool of the same name never takes this
 * path. Reads are silent but flagged as sensitive, as Gmail's are. A write asks with the whole write on the
 * card, unless a standing grant covers the tool; any other name fails closed. Once the chat has read content
 * that is not the person's own words, a write may have been asked for by that content rather than by the
 * person, so it asks first with the steering line on the card, no grant covers it, and a run with nobody
 * to answer skips it, the same way a steered notes write does.
 */
export async function classifyDriveTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
    return autoDenyDecision({
      reason: 'offline_mode',
      reason_detail: 'Google Drive needs network access, which is disabled while offline.',
      sensitive_read: false,
    });
  }
  if (isDriveReadToolName(action.tool_name)) {
    return tier1Decision({
      reason: 'google_drive_read',
      reason_detail: 'Read your Google Drive files.',
      sensitive_read: true,
    });
  }
  if (!isDriveWriteToolName(action.tool_name)) {
    return failClosedDecision({ reason_detail: 'Unknown Drive tool.' });
  }
  const review = action.drive_write;
  if (review === undefined) {
    return autoDenyDecision({
      reason: 'destination_unverifiable',
      reason_detail: 'The change could not be loaded to show you, so it was not offered.',
      sensitive_read: false,
    });
  }
  if (hasReadContent(ctx.web_search.provenance)) {
    if (ctx.services.unattended) {
      return steeredSkipped(ctx);
    }
    const assistant = ctx.web_search.assistantName;
    const say =
      `${assistant} has read things written by other people in this chat, so this write may have been ` +
      `asked for by something it read, not by you.`;
    const card = driveWriteCard({ review, agent_intent: ctx.agent_intent });
    return tier3Decision({
      card: {
        ...card,
        plain_what: withHoldSay(card.plain_what, say),
        copy: card.copy === null ? null : { ...card.copy, reason: say },
      },
      reason: CONTENT_STEERED_REASON,
      reason_detail: say,
      sensitive_read: false,
      standing_grant_barred: true,
      approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
    });
  }
  if (await hasStandingToolGrant(ctx, action)) {
    return tier1Decision({
      reason: TOOL_GRANT_REASON,
      reason_detail: `Always allowed: \`${action.tool_name}\` on your Google Drive.`,
      sensitive_read: false,
    });
  }
  return tier3Decision({
    card: driveWriteCard({ review, agent_intent: ctx.agent_intent }),
    reason: 'google_drive_write',
    reason_detail: 'Creating a Doc or adding rows to a Sheet always asks.',
    sensitive_read: false,
    own_drive_write: true,
    approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
  });
}
