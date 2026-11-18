'use client';

import { ArrowLeft } from 'lucide-react';

import { GoalDetailPage } from '../atoms/goals/GoalDetailPage.js';
import { GoalsListPage } from '../atoms/goals/GoalsListPage.js';
import { useOptionalGoals } from '../goals/GoalsContext.js';
import { useShellMode } from '../server/ShellModeContext.js';

/**
 * The Goals overlay: the list of goals, or one goal when one is selected. It
 * renders nothing unless Goals is open, and nothing at all when no goals API
 * is wired into the shell.
 */
export function GoalsView() {
  const shell = useShellMode();
  const goals = useOptionalGoals();
  const { selectedGoalId, goalsOpen } = shell;
  if (!goalsOpen || goals === null) return null;
  return (
    <section aria-label="Goals" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          aria-label={selectedGoalId !== null ? 'Back to goals' : 'Back'}
          onClick={() => {
            if (selectedGoalId !== null) shell.openGoals();
            else shell.closeGoals();
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-primary transition-colors hover:bg-secondary-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="text-base font-semibold text-text-primary">Goals</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selectedGoalId !== null ? <GoalDetailPage goalId={selectedGoalId} /> : <GoalsListPage />}
      </div>
    </section>
  );
}

export default GoalsView;
