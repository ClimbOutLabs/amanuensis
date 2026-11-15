'use client';

import { useState } from 'react';

import { DraftAuxiliaryModelSelector } from '@/atoms/draft/DraftAuxiliaryModelSelector.js';
import { DraftModelSelector } from '@/atoms/draft/DraftModelSelector.js';
import { MemoryTabs } from '@/atoms/memory/MemoryTabs.js';
import { useOptionalPersonas } from '@/components/PersonaContext.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useAssistantDisplayName } from '../../components/PersonalizationContext.js';
import { HelperModelSelector } from './HelperModelSelector.js';
import { useMemoryNightlySetting } from './memoryHelperSettings.js';
import PersonaSettings from './PersonaSettings.js';

type ModelRolesTab = 'roles' | 'personas';

const MODEL_ROLES_TABS: ReadonlyArray<{ id: ModelRolesTab; label: string }> = [
  { id: 'roles', label: 'Roles' },
  { id: 'personas', label: 'Personas' },
];

/**
 * Which model does which job.
 *
 * Provider connections, credentials, and inventory stay under Models; this
 * page only assigns models to roles. Every role here has a real, separate
 * model call behind it. Uploaded images ride the ordinary chat message and
 * approval is a pure function, so neither can be given a setting that changes
 * anything. The background model is kept on the server, unlike the other roles,
 * because its work also runs when no chat is open.
 *
 * The two halves sit on sub-tabs (the underlined tablist Settings > Memory
 * uses): Roles for the assignments, Personas for the named personas. A host
 * with no personas gets no tab strip and sees the roles alone, exactly as
 * before. The save-failure line stays above the tabs; it belongs to the
 * whole page. The persona list stays mounted (hidden) while Roles is shown, so
 * a persona half-typed in its form survives a trip to the other tab.
 */
const ModelRoleSettings = () => {
  const assistant = useAssistantDisplayName();
  const personas = useOptionalPersonas();
  const { specError } = useTrueFoundryAgentSpec();
  const helper = useMemoryNightlySetting();
  const [tab, setTab] = useState<ModelRolesTab>('roles');
  const activeTab: ModelRolesTab = personas == null ? 'roles' : tab;

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Roles and Personas</h3>
      <p className="mt-1 text-sm text-text-secondary">
        Choose which model does which job. Connect models under Models.
      </p>
      {specError == null ? null : (
        <p role="alert" className="text-failure-bg mt-2 text-sm">
          Unable to save agent settings: {getErrorMessage(specError, 'Could not save these settings. Try again.')}
        </p>
      )}

      {personas == null ? null : (
        <div className="mt-4">
          <MemoryTabs
            ariaLabel="Roles and Personas sections"
            tabs={MODEL_ROLES_TABS}
            activeTab={activeTab}
            onTabChange={setTab}
          />
        </div>
      )}

      <div className="mt-4 flex-1 overflow-y-auto pb-4">
        {activeTab === 'roles' ? (
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
                    Runs sub-agent threads, the delegated work {assistant} hands off. A sub-agent that asks for a
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
                    Summarizes older context so long conversations stay within limits. A poor summary hurts every later
                    turn.
                  </p>
                </div>
                <div className="w-full shrink-0 sm:w-80">
                  <DraftAuxiliaryModelSelector role="compaction" roleLabel="Compaction" />
                </div>
              </article>

              {helper.supported ? (
                <article className="flex flex-col gap-3 border-b border-border p-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <h5 className="text-sm font-medium text-text-primary">Background model</h5>
                    <p className="mt-0.5 text-sm text-text-secondary">
                      Saves what to remember after each chat, tidies your pages and names the chat.
                    </p>
                  </div>
                  <div className="w-full shrink-0 sm:w-80">
                    <HelperModelSelector setting={helper} />
                  </div>
                </article>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-text-secondary">
              Short background checks, like understanding a request to change personas, reuse the main chat model. They
              do not need their own role.
            </p>
          </section>
        ) : null}

        {personas == null ? null : (
          <div hidden={activeTab !== 'personas'}>
            <PersonaSettings />
          </div>
        )}
      </div>
    </>
  );
};

export default ModelRoleSettings;
