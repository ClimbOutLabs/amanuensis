'use client';

import type { RunCodeStatus } from '@truefoundry/trueforge-core/core/sandbox/driver/RunCodeSchemas';
import { createContext, useContext, type FC, type ReactNode } from 'react';

export type { RunCodeStatus } from '@truefoundry/trueforge-core/core/sandbox/driver/RunCodeSchemas';

export type RunCodeStatusApi = {
  /** Live check of whether the run_code sandbox can execute code; rejects when the server cannot be asked. */
  getRunCodeStatus: () => Promise<RunCodeStatus>;
};

const RunCodeStatusContext = createContext<RunCodeStatusApi | null>(null);

export const RunCodeStatusProvider: FC<{
  api: RunCodeStatusApi;
  children: ReactNode;
}> = ({ api, children }) => <RunCodeStatusContext.Provider value={api}>{children}</RunCodeStatusContext.Provider>;

export function useOptionalRunCodeStatus(): RunCodeStatusApi | null {
  return useContext(RunCodeStatusContext);
}
