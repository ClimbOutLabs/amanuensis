'use client';

import { useCallback, useEffect, useState } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import {
  MAPS_SERVER_FIELD_IDS,
  MAPS_SERVER_FIELD_LABELS,
  mapsServerUrlProblem,
  type MapsServerFieldId,
  type MapsSettingsState,
  type MapsSettingsTestResults,
  type MapsSettingsUpdate,
  type MapsSetupPort,
} from '@/server/mapsSetup.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';

type Drafts = Record<MapsServerFieldId, string>;
type Problems = Partial<Record<MapsServerFieldId, string>>;

function draftsFromState(state: MapsSettingsState): Drafts {
  return {
    router: state.router.value ?? '',
    walking: state.walking.value ?? '',
    cycling: state.cycling.value ?? '',
    geocoder: state.geocoder.value ?? '',
    transit: state.transit.value ?? '',
    tile: state.tile.value ?? '',
  };
}

/**
 * The Maps card on Settings, Connectors: the six maps server addresses an
 * admin can point at servers they run. An address the environment sets is
 * read-only and wins; a saved address beats the built-in default shown as the
 * placeholder. Changes take effect on the next maps request, with no restart.
 * The card renders nothing until its first read succeeds, so a non-admin,
 * whose read the server refuses, never sees it.
 */
export default function MapsSettingsCard({ port }: { port: MapsSetupPort }) {
  const [state, setState] = useState<MapsSettingsState | null>(null);
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [problems, setProblems] = useState<Problems>({});
  const [results, setResults] = useState<MapsSettingsTestResults | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await port.getMapsSettings();
      setState(next);
      setDrafts(draftsFromState(next));
    } catch {
      // A refused read (a non-admin) or a failed one leaves the card hidden.
      setState(null);
      setDrafts(null);
    }
  }, [port]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === null || drafts === null) {
    return null;
  }

  const changedFields = MAPS_SERVER_FIELD_IDS.filter(fieldId => {
    const field = state[fieldId];
    return !field.setByEnvironment && drafts[fieldId] !== (field.value ?? '');
  });
  const hasChanges = changedFields.length > 0;

  /** The update for the current drafts, or the problems that stop it. */
  const buildUpdate = (): { update: MapsSettingsUpdate } | { problems: Problems } => {
    const update: MapsSettingsUpdate = {};
    const nextProblems: Problems = {};
    for (const fieldId of changedFields) {
      const draft = drafts[fieldId].trim();
      if (draft === '') {
        update[fieldId] = null;
        continue;
      }
      const problem = mapsServerUrlProblem({ field: fieldId, value: draft });
      if (problem !== null) {
        nextProblems[fieldId] = problem;
        continue;
      }
      update[fieldId] = draft;
    }
    return Object.keys(nextProblems).length > 0 ? { problems: nextProblems } : { update };
  };

  const applyState = (next: MapsSettingsState) => {
    setState(next);
    setDrafts(draftsFromState(next));
    setProblems({});
    setResults(null);
  };

  const handleSave = async () => {
    const built = buildUpdate();
    if ('problems' in built) {
      setProblems(built.problems);
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      applyState(await port.updateMapsSettings(built.update));
    } catch (error) {
      setSaveError(getErrorMessage(error, 'The maps addresses could not be saved. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    // Test connections speaks to the addresses in force, so unsaved changes
    // are saved first; the brief's flow (type an address, test it, see ok)
    // then works in one press.
    if (hasChanges) {
      const built = buildUpdate();
      if ('problems' in built) {
        setProblems(built.problems);
        return;
      }
      setBusy(true);
      setSaveError(null);
      try {
        applyState(await port.updateMapsSettings(built.update));
      } catch (error) {
        setSaveError(getErrorMessage(error, 'The maps addresses could not be saved. Try again.'));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    setTesting(true);
    setSaveError(null);
    try {
      setResults(await port.testMapsSettings());
    } catch (error) {
      setSaveError(getErrorMessage(error, 'The connection test could not run. Try again.'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section aria-labelledby="maps-connector-heading">
      <h4 id="maps-connector-heading" className="mb-2 text-[0.8125rem] font-semibold uppercase text-text-secondary">
        Maps
      </h4>
      <div className="rounded-xl border border-border bg-card-bg p-4">
        <p className="text-sm text-text-secondary">
          Maps use free public OpenStreetMap services unless you set your own. Light personal use is fine. For heavier
          use, or to keep your routes off public servers, point these at servers you run.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          {MAPS_SERVER_FIELD_IDS.map(fieldId => {
            const field = state[fieldId];
            const result = results?.[fieldId] ?? null;
            const problem = problems[fieldId] ?? null;
            const inputId = `maps-server-${fieldId}`;
            return (
              <div key={fieldId}>
                <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-text-primary">
                  {MAPS_SERVER_FIELD_LABELS[fieldId]}
                </label>
                <div className="flex items-start gap-2">
                  <input
                    id={inputId}
                    type="text"
                    value={field.setByEnvironment ? (field.value ?? '') : drafts[fieldId]}
                    placeholder={field.defaultUrl}
                    readOnly={field.setByEnvironment}
                    disabled={busy || testing}
                    onChange={event => {
                      const next = event.target.value;
                      setDrafts(current => (current === null ? current : { ...current, [fieldId]: next }));
                      setProblems(current => {
                        if (current[fieldId] === undefined) return current;
                        const rest = { ...current };
                        delete rest[fieldId];
                        return rest;
                      });
                      setResults(null);
                    }}
                    className={auiInputClass('h-10 flex-1')}
                  />
                  {field.setByEnvironment ? null : (
                    <Button
                      variant="ghost"
                      size="small"
                      type="button"
                      disabled={busy || testing || drafts[fieldId] === ''}
                      onClick={() => {
                        setDrafts(current => (current === null ? current : { ...current, [fieldId]: '' }));
                      }}
                    >
                      Reset to default
                    </Button>
                  )}
                </div>
                {field.setByEnvironment ? (
                  <p className="mt-1 text-xs text-text-secondary">Set by the server environment</p>
                ) : null}
                {problem !== null ? (
                  <p className="mt-1 text-sm text-failure-bg" role="alert">
                    {problem}
                  </p>
                ) : result !== null ? (
                  <p className={cn('mt-1 text-sm', result.ok ? 'text-success-bg' : 'text-failure-bg')} role="status">
                    {result.ok ? 'ok' : result.message}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        {saveError !== null ? (
          <p className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
            {saveError}
          </p>
        ) : null}
        <div className="mt-4 flex gap-2">
          <Button type="button" disabled={busy || testing || !hasChanges} onClick={() => void handleSave()}>
            Save
          </Button>
          <Button variant="secondary" type="button" disabled={busy || testing} onClick={() => void handleTest()}>
            {testing ? 'Testing…' : 'Test connections'}
          </Button>
        </div>
      </div>
    </section>
  );
}
