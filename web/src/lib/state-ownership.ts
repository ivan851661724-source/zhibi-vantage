import { captureSession, isSessionCurrent } from '@/lib/storage-scope';

export interface StateOperation {
  projectId: string | null;
  kind: 'local' | 'switch';
  isCurrent: () => boolean;
}

// UI request ownership, not a domain state. A→B→A must invalidate the first A generation.
export function createStateOwnership() {
  let projectId: string | null = null;
  let generation = 0;
  let switchOrder = 0;
  return {
    adopt(next: string | null) { if (next !== projectId) { projectId = next; generation++; } },
    reset() { projectId = null; generation++; switchOrder++; },
    capture(expected: string | null, alive: () => boolean): StateOperation {
      const session = captureSession(), started = generation;
      return { projectId: expected, kind: 'local', isCurrent: () => alive() && isSessionCurrent(session) && expected === projectId && started === generation };
    },
    beginSwitch(target: string, alive: () => boolean): StateOperation {
      generation++;
      const order = ++switchOrder, session = captureSession();
      return { projectId: target, kind: 'switch', isCurrent: () => alive() && isSessionCurrent(session) && order === switchOrder };
    },
  };
}
