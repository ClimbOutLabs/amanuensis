/**
 * Nightly step 1: a statement under Now, Decided or Open whose end day has passed moves to Earlier with that end
 * day. It applies only dates a page already holds, so it needs no model and runs in every sorting mode.
 */
import { commitPageChange, type PageChangeOptions } from './memoryPageWriter';
import {
  listMemoryPages,
  moveFactToEarlier,
  pageFacts,
  readMemoryPage,
  writeMemoryPage,
  type FactLocation,
  type MemoryPage,
  type PageSection,
} from './memoryPages';
import { endedBefore } from './statementDates';

const CURRENT_SECTIONS: ReadonlySet<PageSection | undefined> = new Set<PageSection>(['Now', 'Decided', 'Open']);

function firstEnded({ page, today }: { page: MemoryPage; today: string }): FactLocation | undefined {
  return pageFacts(page).find(at => {
    const { until } = at.fact.marker;
    return CURRENT_SECTIONS.has(at.section.name) && until !== undefined && endedBefore({ until, today });
  });
}

/** The page with every ended statement moved, and how many moved. Each move changes the line positions, so it looks again. */
function withEndedMoved({ page, today }: { page: MemoryPage; today: string }): { page: MemoryPage; moved: number } {
  let current = page;
  let moved = 0;
  for (let at = firstEnded({ page: current, today }); at !== undefined; at = firstEnded({ page: current, today })) {
    const { until } = at.fact.marker;
    if (until === undefined) {
      break;
    }
    current = moveFactToEarlier(current, { at, until });
    moved += 1;
  }
  return { page: current, moved };
}

async function anyEnded({ vaultDir, today }: { vaultDir: string; today: string }): Promise<boolean> {
  for (const { kind, slug } of await listMemoryPages(vaultDir)) {
    const page = await readMemoryPage({ vaultDir, kind, slug });
    if (page !== undefined && firstEnded({ page, today }) !== undefined) {
      return true;
    }
  }
  return false;
}

function messageFor(moved: number): string {
  return `Aman moved ${String(moved)} ended ${moved === 1 ? 'line' : 'lines'} to Earlier`;
}

/** Moves the ended statements of every page of the vault in one history entry. Writes nothing when none ended. Returns how many moved. */
export async function moveEndedStatements({ options }: { options: PageChangeOptions }): Promise<number> {
  const { vaultDir, today } = options;
  if (!(await anyEnded({ vaultDir, today }))) {
    return 0;
  }
  return commitPageChange({
    options,
    message: messageFor,
    change: async () => {
      let total = 0;
      for (const { kind, slug } of await listMemoryPages(vaultDir)) {
        const page = await readMemoryPage({ vaultDir, kind, slug });
        if (page === undefined) {
          continue;
        }
        const { page: changed, moved } = withEndedMoved({ page, today });
        if (moved > 0) {
          await writeMemoryPage({ vaultDir, kind, slug, page: changed });
          total += moved;
        }
      }
      return total;
    },
  });
}
