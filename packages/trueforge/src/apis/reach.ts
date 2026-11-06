import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import type { INoticingStore } from '../db/noticingStore';
import type { IReachSettingsStore } from '../db/reachSettingsStore';
import type { ITextContactStore } from '../db/textContactStore';
import {
  getReachRoute,
  listReachSuggestionsRoute,
  testReachChannelRoute,
  updateReachRoute,
} from '../routes/reachRoutes';
import type { PhoneCallService } from '../runtime/calls/phoneCalls';
import { claimTestCall } from '../runtime/calls/testCallLimits';
import { callFailureWords } from '../runtime/calls/twilioCalls';
import type { DeliveryService } from '../runtime/delivery/deliveryService';
import { KIND_MAX_LEVEL } from '../runtime/noticing/levels';
import { MAIL_PROBLEM_SHOWN_AFTER_MS } from '../runtime/noticing/noticingService';
import { suggestAlwaysImportant } from '../runtime/noticing/suggestions';
import {
  claimTextLimits,
  dayLimitWords,
  deliveryTextLimits,
  MAX_TEST_TEXTS_PER_HOUR,
  testTextLimit,
  textLimitsRoom,
  waitWords,
  type DeliveryLimitSettings,
} from '../runtime/texts/textLimits';
import { canText } from '../runtime/texts/textNumber';
import type { ReachAvailability } from '../schemas/reach';
import { defaultReachSettings, NOTICING_KINDS, type AlwaysImportantSender, type ReachSettings } from '../schemas/reach';

const TEST_WORDS = 'This is a test. If you can read this, it works.';

export interface ReachRouterDeps {
  reachStore: IReachSettingsStore;
  textContacts: Pick<ITextContactStore, 'get' | 'claimTextSend' | 'forgetTextSends' | 'textSendRoom'>;
  /** Undefined when this server has no text provider. */
  textLimits: DeliveryLimitSettings | undefined;
  /** Where each watcher's trouble is kept, so Reach me can say mail is not being checked. */
  noticingStore: Pick<INoticingStore, 'getCheckpoint'>;
  deliveryService: Pick<DeliveryService, 'deliver' | 'recordAttempt'>;
  /** Places a test call. */
  calls: Pick<PhoneCallService, 'place'>;
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
    const failure = (await deps.noticingStore.getCheckpoint({ ...owner, watcher: 'mail' }))?.failure;
    const failing = failure !== undefined && now().getTime() - failure.since.getTime() >= MAIL_PROBLEM_SHOWN_AFTER_MS;
    return {
      settings: stored ?? defaultReachSettings('UTC'),
      saved: stored !== undefined,
      availability: deps.channels(),
      max_levels: KIND_MAX_LEVEL,
      mail_problem: failing ? { since: failure.since.toISOString(), kind: failure.kind } : null,
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
    // Calls already on stay on while the voice parts are briefly down; only switching them on needs them now.
    const callsWereOn = (await deps.reachStore.get(owner))?.channels.calls === true;
    if (settings.channels.calls && !channels.calls.available && !callsWereOn) {
      return c.json({ error: { message: `${channels.calls.note} Leave calls off for now.` } }, 400);
    }
    if (settings.channels.calls) {
      const contact = await deps.textContacts.get(owner);
      if (!canText(contact)) {
        return c.json(
          {
            error: {
              message:
                'Calls ring the number you confirm under Texts. Confirm your number first, then switch calls on.',
            },
          },
          400,
        );
      }
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
      if (!channels.texts.available || deps.textLimits === undefined) {
        return c.json({ error: { message: `${channels.texts.note} Try the app or push notices for now.` } }, 409);
      }
      const settings = await deps.reachStore.get(owner);
      const contact = await deps.textContacts.get(owner);
      if (settings?.channels.texts !== true || !canText(contact)) {
        return c.json({ error: { message: 'Confirm your number and switch texts on first, then try again.' } }, 409);
      }
      const at = now();
      // A day's limit that is already reached would refuse the text, so the test is not counted.
      const day = deliveryTextLimits({ owner, phone: contact.phone, settings: deps.textLimits });
      const room = await textLimitsRoom({ store: deps.textContacts, limits: [day.person, day.number, day.server], at });
      if (!room.ok) {
        return c.json({ error: { message: dayLimitWords({ limits: day, refused: room }) } }, 429);
      }
      // Each test is a paid text, so the button has a limit of its own on top of the day's limit for every text.
      const claim = await claimTextLimits({ store: deps.textContacts, limits: [testTextLimit(owner)], at });
      if (!claim.ok) {
        return c.json(
          {
            error: {
              message: `That was ${String(MAX_TEST_TEXTS_PER_HOUR)} test texts this hour. Wait ${waitWords(claim.retry_in_minutes)}, then try again.`,
            },
          },
          429,
        );
      }
      const delivery = await deps.deliveryService.deliver({
        ...owner,
        // A note in the feed, so a test never uses up one of the day's nudges.
        kind: 'note',
        level: 'nudge',
        text: TEST_WORDS,
        reason: 'You pressed Try it in Reach me settings.',
        link: null,
        only_channels: ['sms'],
      });
      const sent = delivery.attempts.find(attempt => attempt.channel === 'sms');
      if (sent?.outcome === 'skipped') {
        // Only a day's limit reached since the check above skips a confirmed number with texts on.
        return c.json({ error: { message: sent.detail ?? 'No text was sent. Try again later.' } }, 429);
      }
      if (sent?.outcome !== 'sent') {
        return c.json(
          { error: { message: sent?.detail ?? 'The test text could not be sent. Try again in a minute.' } },
          502,
        );
      }
      return c.json({ data: { delivery_id: delivery.id, devices_reached: 0 } }, 201);
    }
    if (channel === 'call') {
      if (!channels.calls.available) {
        return c.json({ error: { message: `${channels.calls.note} There is nothing to try yet.` } }, 409);
      }
      const settings = await deps.reachStore.get(owner);
      const contact = await deps.textContacts.get(owner);
      if (settings?.channels.calls !== true || !canText(contact)) {
        return c.json({ error: { message: 'Confirm your number and switch calls on first, then try again.' } }, 409);
      }
      const claim = await claimTestCall({ store: deps.textContacts, owner, at: now() });
      if (!claim.ok) {
        return c.json({ error: { message: claim.message } }, 429);
      }
      // A note in the feed that only the app shows, so a test never counts toward the time between calls. The call
      // itself is placed below, and a test call never falls back to a text.
      const delivery = await deps.deliveryService.deliver({
        ...owner,
        kind: 'note',
        level: 'nudge',
        text: 'This is a test call. If you can hear this, calls work.',
        reason: 'You pressed Try it in Reach me settings.',
        link: null,
        only_channels: [],
      });
      const rang = await deps.calls.place({ owner, delivery, fallback: false });
      await deps.deliveryService.recordAttempt({ ...owner, delivery_id: delivery.id, attempt: rang });
      if (rang.outcome !== 'sent') {
        return c.json({ error: { message: rang.detail ?? callFailureWords('unreachable') } }, 502);
      }
      return c.json({ data: { delivery_id: delivery.id, devices_reached: 0 } }, 201);
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
      only_channels: channel === 'push' ? ['web_push'] : [],
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
