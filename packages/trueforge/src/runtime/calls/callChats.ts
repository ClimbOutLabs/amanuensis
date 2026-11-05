import type { CreatedBySubject, ISessionStore, Sessions } from '@truefoundry/trueforge-core/agent-session';

import type { RequestContext } from '../../auth/identity';
import { grantInProcessCaller, IN_PROCESS_CALLER_HEADER } from '../../auth/inProcessCaller';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { SessionCustom, TurnCustom } from '../../db/sessionCustom';
import { HttpVoiceTurnRunner } from '../../voice/turnRunner';
import type { SelfFetch } from '../../voice/voiceSocket';
import { appendAssistantLine } from '../assistantLine';
import type { CallChats } from './phoneCalls';

/** The title a call's chat gets. */
export const PHONE_CALL_CHAT_TITLE = 'Phone call';

/**
 * Each call talks in a chat of its own, written as the person and run through the app's own turn route, so the same
 * assistant, tools and approvals apply as to a typed message. The chat takes the assistant of the chat the delivery
 * points to, or else the person's latest chat. A person who has never chatted has no assistant to talk to.
 */
export function createCallChats({
  sessionStore,
  sessions,
  reachSettings,
  selfFetch,
  contextFor,
  port,
  now = () => new Date(),
}: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  /** Read when needed: sessions are made after the delivery channels. */
  sessions: () => Pick<Sessions<SessionCustom, TurnCustom>, 'getOrCreateByExternalId'>;
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  /** Runs a request against this server's own app, in this process. */
  selfFetch: () => SelfFetch;
  /** Who the person is to the app's routes, as their own sign-in would say. */
  contextFor: (input: { tenant_id: string; subject: CreatedBySubject }) => RequestContext;
  port: number;
  now?: () => Date;
}): CallChats {
  return {
    async open({ owner, delivery, call_id, opening }) {
      const linkedId = delivery.link !== null && 'session_id' in delivery.link ? delivery.link.session_id : undefined;
      const linked =
        linkedId === undefined
          ? undefined
          : await sessionStore.getSession({ tenant_id: owner.tenant_id, session_id: linkedId });
      const base =
        linked?.created_by_subject.subject_id === owner.created_by
          ? linked
          : (
              await sessionStore.listSessions({
                tenant_id: owner.tenant_id,
                limit: 1,
                page_token: undefined,
                order: 'desc',
                start_timestamp: undefined,
                end_timestamp: undefined,
                agent_id: undefined,
                folder_id: undefined,
                no_folder: false,
                created_by_or_agent_ids: { created_by_subject_id: owner.created_by, agent_ids: [] },
                metadata: undefined,
                source_type: undefined,
                source_id: undefined,
              })
            ).data[0];
      if (base === undefined) {
        return undefined;
      }
      const { session } = await sessions().getOrCreateByExternalId({
        tenant_id: owner.tenant_id,
        external_id: `phone-call:${call_id}`,
        created_by_subject: base.created_by_subject,
        agent: base.agent,
      });
      await appendAssistantLine({
        sessionStore,
        tenant_id: owner.tenant_id,
        session_id: session.session_id,
        text: opening,
        title: PHONE_CALL_CHAT_TITLE,
        now: now(),
      });
      const grant = grantInProcessCaller(contextFor({ tenant_id: owner.tenant_id, subject: base.created_by_subject }));
      const fetchApp = selfFetch();
      const request = (path: string, init: RequestInit): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set(IN_PROCESS_CALLER_HEADER, grant.key);
        headers.set('sec-fetch-site', 'same-origin');
        return Promise.resolve(fetchApp(new Request(`http://localhost:${String(port)}${path}`, { ...init, headers })));
      };
      const settings = await reachSettings.get(owner);
      return {
        session_id: session.session_id,
        turns: new HttpVoiceTurnRunner({ request, sessionId: session.session_id, clientTimezone: settings?.timezone }),
        close: grant.revoke,
      };
    },
  };
}
