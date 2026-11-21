'use client';

import { useState } from 'react';

import { useOptionalGoals } from '../../goals/GoalsContext.js';
import { Icon } from '../../icons/Icon.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import { railMenuRowClassName } from '../lib/buttonClasses.js';
import { GoalCreateDialog } from './GoalCreateDialog.js';

/**
 * Make this a goal, in a chat's menu. It opens the new goal form as a draft;
 * when the chat belongs to a saved agent, that agent is picked first in the
 * form, and the owner can still choose another. Renders nothing where no
 * goals API is wired in.
 */
export function MakeGoalMenuItem() {
  const goals = useOptionalGoals();
  const shell = useOptionalShellMode();
  const [open, setOpen] = useState(false);

  if (goals === null || shell === null) return null;
  const boundAgentId = shell.mode.status === 'active' && !shell.mode.isMutable ? (shell.mode.agentId ?? null) : null;

  return (
    <>
      <button type="button" role="menuitem" className={railMenuRowClassName} onClick={() => setOpen(true)}>
        <Icon name="target" size="0.875rem" />
        Make this a goal
      </button>
      {open ? (
        <GoalCreateDialog
          open
          initialAgentId={boundAgentId}
          onClose={() => setOpen(false)}
          onCreated={detail => {
            setOpen(false);
            shell.openGoals(detail.goal.goalId);
          }}
        />
      ) : null}
    </>
  );
}
