import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { INoticingStore } from '../db/noticingStore';
import type { IReachSettingsStore } from '../db/reachSettingsStore';
import {
  getReachRoute,
  listReachSuggestionsRoute,
  testReachChannelRoute,
  updateReachRoute,
} from '../routes/reachRoutes';
import type { DeliveryService } from '../runtime/delivery/deliveryService';
import { KIND_MAX_LEVEL } from '../runtime/noticing/levels';
import { calendarProblemOf, mailProblemOf } from '../runtime/noticing/noticingService';
import { suggestAlwaysImportant } from '../runtime/noticing/suggestions';
import type { ReachAvailability } from '../schemas/reach';
import { defaultReachSettings, NOTICING_KINDS, type AlwaysImportantSender, type ReachSettings } from '../schemas/reach';

export interface ReachRouterDeps {
  reachStore: IReachSettingsStore;
  /** Where each watcher's trouble is kept, so Reach me can say mail is not being checked. */
  noticingStore: Pick<INoticingStore, 'getCheckpoint'>;
  deliveryService: Pick<DeliveryService, 'deliver'>;
  /** Which phone channels this server can use now. Read per request, since a later part may set one up while running. */
  channels: () => ReachAvailability;
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
      availability: deps.channels(),
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
    // Texts and calls have no test of their own yet; the part that sets one up adds it here.
    if (channel === 'text' || channel === 'call') {
      const status = channel === 'text' ? channels.texts : channels.calls;
      return c.json({ error: { message: `${status.note} Try the app or push notices for now.` } }, 409);
    }
    // A test is a note in the feed, so a push test never uses up one of the day's nudges.
    const delivery = await deps.deliveryService.deliver({
      ...owner,
      kind: 'note',
      level: channel === 'push' ? 'nudge' : 'note',
      text: 'This is a test. If you can read this, it works.',
      reason: 'You pressed Try it in Reach me settings.',
      link: null,
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
