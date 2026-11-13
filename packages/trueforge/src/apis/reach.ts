import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { INoticingStore } from '../db/noticingStore';
import type { PersonOwner } from '../db/personOwner';
import type { IReachSettingsStore } from '../db/reachSettingsStore';
import type { ITextContactStore } from '../db/textContactStore';
import {
  getReachRoute,
  listReachSuggestionsRoute,
  testReachChannelRoute,
  updateReachRoute,
} from '../routes/reachRoutes';
import { TEST_WORDS } from '../runtime/delivery/deliveryChannel';
import type { DeliveryService } from '../runtime/delivery/deliveryService';
import { KIND_MAX_LEVEL } from '../runtime/noticing/levels';
import { calendarProblemOf, mailProblemOf } from '../runtime/noticing/noticingService';
import type { ChannelViewer } from '../runtime/noticing/reachChannels';
import { suggestAlwaysImportant } from '../runtime/noticing/suggestions';
import { smsFailureWords } from '../runtime/texts/smsProvider';
import { canText } from '../runtime/texts/textNumber';
import type { ReachAvailability } from '../schemas/reach';
import { defaultReachSettings, NOTICING_KINDS, type AlwaysImportantSender, type ReachSettings } from '../schemas/reach';

export interface ReachRouterDeps {
  reachStore: IReachSettingsStore;
  textContacts: Pick<ITextContactStore, 'get'>;
  /** Where each watcher's trouble is kept, so Reach me can say mail is not being checked. */
  noticingStore: Pick<INoticingStore, 'getCheckpoint'>;
  deliveryService: Pick<DeliveryService, 'deliver'>;
  /**
   * Which phone channels this server can use now. Read per request, since a later part may set one up while running.
   * The viewer only changes how a problem is worded.
   */
  channels: (input?: { viewer: ChannelViewer }) => ReachAvailability;
  /** Whether this person runs Aman, so a problem with the server's setup is worded for them. */
  isInstanceOwner: (owner: PersonOwner) => boolean;
  /** The texts of the memories that may name a sender. Empty when this server keeps no readable memory. */
  memories: (input: { tenant_id: string }) => Promise<string[]>;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  now?: () => Date;
}

/**
 * The settings to keep: each always-important sender keeps the time and source the server first recorded, and a new
 * one is stamped now with the source the person's request names. Nothing the client says about when is trusted.
 */
function normalized({
  incoming,
  previous,
  now,
}: {
  incoming: ReachSettings;
  previous: ReachSettings | undefined;
  now: Date;
}): ReachSettings {
  const known = new Map((previous?.always_important ?? []).map(sender => [sender.address, sender]));
  const seen = new Set<string>();
  const always: AlwaysImportantSender[] = [];
  for (const sender of incoming.always_important) {
    if (seen.has(sender.address)) {
      continue;
    }
    seen.add(sender.address);
    const earlier = known.get(sender.address);
    always.push(
      earlier === undefined
        ? { address: sender.address, name: sender.name, source: sender.source, added_at: now.toISOString() }
        : { ...earlier, name: sender.name },
    );
  }
  return {
    ...incoming,
    always_important: always,
    dismissed_suggestions: [...new Set(incoming.dismissed_suggestions.map(address => address.toLowerCase()))],
    call_kinds: NOTICING_KINDS.filter(kind => incoming.call_kinds.includes(kind)),
  };
}

/** The signed-in person's Reach me settings, mounted at /api/v1/user/reach. */
export function createReachRouter(deps: ReachRouterDeps) {
  const now = deps.now ?? (() => new Date());
  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const context = deps.resolveRequestContext(c);
    return { tenant_id: context.tenant_id, created_by: context.subject.id };
  };

  const view = async (owner: ReturnType<typeof ownerOf>) => {
    const stored = await deps.reachStore.get(owner);
    const settings = stored ?? defaultReachSettings('UTC');
    // With the checks off nothing is being checked, so there is no trouble or watched mailbox to show.
    const checkpoint = settings.noticing_on
      ? await deps.noticingStore.getCheckpoint({ ...owner, watcher: 'mail' })
      : undefined;
    const calendar = settings.noticing_on
      ? await deps.noticingStore.getCheckpoint({ ...owner, watcher: 'calendar' })
      : undefined;
    const problem = mailProblemOf({ checkpoint, now: now() });
    const calendarProblem = calendarProblemOf({ checkpoint: calendar, now: now() });
    return {
      settings,
      saved: stored !== undefined,
      availability: deps.channels({ viewer: deps.isInstanceOwner(owner) ? 'owner' : 'person' }),
      max_levels: KIND_MAX_LEVEL,
      mail_problem: problem === undefined ? null : { since: problem.since.toISOString(), kind: problem.kind },
      calendar_problem:
        calendarProblem === undefined
          ? null
          : { since: calendarProblem.since.toISOString(), kind: calendarProblem.kind },
      mail_source: checkpoint?.source ?? null,
    };
  };

  const getHandler: RouteHandler<typeof getReachRoute> = async c => c.json({ data: await view(ownerOf(c)) }, 200);

  const updateHandler: RouteHandler<typeof updateReachRoute> = async c => {
    const owner = ownerOf(c);
    const { settings } = c.req.valid('json');
    const channels = deps.channels();
    if (settings.channels.texts && !channels.texts.available) {
      return c.json({ error: { message: `${channels.texts.note} Leave texts off for now.` } }, 400);
    }
    if (settings.channels.texts) {
      const contact = await deps.textContacts.get(owner);
      if (!canText(contact)) {
        return c.json(
          { error: { message: 'Confirm your number first. Enter it and the code we text you, then switch texts on.' } },
          400,
        );
      }
    }
    if (settings.channels.calls && !channels.calls.available) {
      return c.json({ error: { message: `${channels.calls.note} Leave calls off for now.` } }, 400);
    }
    const blocked = settings.call_kinds.find(kind => KIND_MAX_LEVEL[kind] !== 'call');
    if (blocked !== undefined) {
      return c.json(
        { error: { message: 'That kind of event can reach you as a nudge at most. Untick it for calls.' } },
        400,
      );
    }
    const previous = await deps.reachStore.get(owner);
    await deps.reachStore.put({ ...owner, settings: normalized({ incoming: settings, previous, now: now() }) });
    return c.json({ data: await view(owner) }, 200);
  };

  const suggestionsHandler: RouteHandler<typeof listReachSuggestionsRoute> = async c => {
    const owner = ownerOf(c);
    const stored = (await deps.reachStore.get(owner)) ?? defaultReachSettings('UTC');
    let memories: string[] = [];
    try {
      memories = await deps.memories({ tenant_id: owner.tenant_id });
    } catch (error) {
      // A memory that cannot be read means no suggestions, never a broken page.
      deps.logger.warn('Memory could not be read for always-important suggestions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return c.json({ data: suggestAlwaysImportant({ memories, settings: stored }) }, 200);
  };

  const testHandler: RouteHandler<typeof testReachChannelRoute> = async c => {
    const owner = ownerOf(c);
    const { channel } = c.req.valid('json');
    const channels = deps.channels();
    if (channel === 'text') {
      if (!channels.texts.available) {
        return c.json({ error: { message: `${channels.texts.note} Try the app or push notices for now.` } }, 409);
      }
      const notOn = 'Confirm your number and switch texts on first, then try again.';
      const settings = await deps.reachStore.get(owner);
      if (settings?.channels.texts !== true || !canText(await deps.textContacts.get(owner))) {
        return c.json({ error: { message: notOn } }, 409);
      }
      // The text sender claims the day's limits and the button's own limit together, so a refused test counts nowhere.
      const delivery = await deps.deliveryService.deliver({
        ...owner,
        // A note in the feed, so a test never uses up one of the day's nudges.
        kind: 'note',
        level: 'nudge',
        text: TEST_WORDS,
        reason: 'You pressed Try it in Reach me settings.',
        link: null,
        test: 'sms',
      });
      const sent = delivery.attempts.find(attempt => attempt.channel === 'sms');
      if (sent === undefined || sent.outcome === 'skipped') {
        // A confirmed number with texts on is skipped only by a limit. Otherwise, between the check above and the
        // send, texts were switched off or the number replied STOP, which also switches them off.
        const contact = await deps.textContacts.get(owner);
        if (sent?.outcome === 'skipped' && canText(contact)) {
          return c.json({ error: { message: sent.detail ?? 'No text was sent. Try again later.' } }, 429);
        }
        const stopped = typeof contact?.opted_out_at === 'string';
        return c.json(
          { error: { message: stopped ? smsFailureWords({ failure: 'opted_out', during: 'delivery' }) : notOn } },
          409,
        );
      }
      if (sent.outcome !== 'sent') {
        return c.json(
          { error: { message: sent.detail ?? 'The test text could not be sent. Try again in a minute.' } },
          502,
        );
      }
      return c.json({ data: { delivery_id: delivery.id, devices_reached: 0 } }, 201);
    }
    if (channel === 'call') {
      return c.json({ error: { message: `${channels.calls.note} Try the app or push notices for now.` } }, 409);
    }
    // A test is a note in the feed, so a push test never uses up one of the day's nudges, and it reaches only the
    // person's devices, so it never sends a paid text.
    const delivery = await deps.deliveryService.deliver({
      ...owner,
      kind: 'note',
      level: channel === 'push' ? 'nudge' : 'note',
      text: TEST_WORDS,
      reason: 'You pressed Try it in Reach me settings.',
      link: null,
      test: channel === 'push' ? 'web_push' : 'in_app',
    });
    const devices_reached = delivery.attempts.filter(
      attempt => attempt.channel === 'web_push' && attempt.outcome === 'sent',
    ).length;
    return c.json({ data: { delivery_id: delivery.id, devices_reached } }, 201);
  };

  const router = new OpenAPIHono();
  router.openapi(getReachRoute, getHandler);
  router.openapi(updateReachRoute, updateHandler);
  router.openapi(listReachSuggestionsRoute, suggestionsHandler);
  router.openapi(testReachChannelRoute, testHandler);
  return router;
}
