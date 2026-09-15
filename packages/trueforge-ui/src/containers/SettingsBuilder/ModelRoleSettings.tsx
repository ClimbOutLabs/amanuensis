'use client';

import { DraftAuxiliaryModelSelector } from '@/atoms/draft/DraftAuxiliaryModelSelector.js';
import { DraftModelSelector } from '@/atoms/draft/DraftModelSelector.js';
import { useOptionalPersonas } from '@/components/PersonaContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import PersonaSettings from './PersonaSettings.js';

/**
 * Which model does which job.
 *
 * Provider connections, credentials, and inventory stay under Models; this
 * page only assigns models to roles. Every role here has a real, separate
 * model call behind it. Title generation is a string slice, uploaded images
 * ride the ordinary chat message, and approval is a pure function, so none of
 * them can be given a setting that changes anything.
 */
const ModelRoleSettings = () => {
  const personas = useOptionalPersonas();
  const { specError } = useTrueFoundryAgentSpec();

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Model roles</h3>
      <p className="mt-1 text-sm text-text-secondary">
        Choose which model does which job. Connections and model inventory live under Models.
      </p>
      {specError == null ? null : (
        <p role="alert" className="text-failure-bg mt-2 text-sm">
          Unable to save agent settings: {getErrorMessage(specError, 'The server rejected this settings change.')}
        </p>
      )}

      <div className="mt-4 flex-1 overflow-y-auto pb-4">
        <section aria-labelledby="chat-roles-heading">
          <div id="chat-roles-heading" className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary">
            Roles
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
            <article className="flex flex-col gap-3 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <h5 className="text-sm font-medium text-text-primary">Main chat model</h5>
                <p className="mt-0.5 text-sm text-text-secondary">
                  Answers you directly. Every role below inherits this one unless you set it explicitly.
                </p>
              </div>
              <div className="w-full shrink-0 sm:w-80">
                <DraftModelSelector />
              </div>
            </article>

            <article className="flex flex-col gap-3 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <h5 className="text-sm font-medium text-text-primary">Coding / subagent model</h5>
                <p className="mt-0.5 text-sm text-text-secondary">
                  Runs sub-agent threads, the delegated work the assistant hands off. A sub-agent that asks for a
                  specific model still gets it.
                </p>
              </div>
              <div className="w-full shrink-0 sm:w-80">
                <DraftAuxiliaryModelSelector role="delegation" roleLabel="Coding / subagent" />
              </div>
            </article>

            <article className="flex flex-col gap-3 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <h5 className="text-sm font-medium text-text-primary">Compaction model</h5>
                <p className="mt-0.5 text-sm text-text-secondary">
                  Summarizes older context so long conversations stay within limits. A cheaper model is tempting, since
                  summarizing is easier than reasoning. A poor summary degrades every later turn in the conversation.
                </p>
              </div>
              <div className="w-full shrink-0 sm:w-80">
                <DraftAuxiliaryModelSelector role="compaction" roleLabel="Compaction" />
              </div>
            </article>
          </div>
          <p className="mt-2 text-sm text-text-secondary">
            Short control-plane checks, such as understanding a natural request to change personas, reuse the main chat
            model. They do not need a separate model role. Session titles remain deterministic, images ride the ordinary
            chat message, and approvals are decided without a model.
          </p>
        </section>

        {personas == null ? null : <PersonaSettings />}
      </div>
    </>
  );
};

export default ModelRoleSettings;
