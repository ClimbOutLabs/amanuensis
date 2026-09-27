// Three-tier responsive width allocation for the TUI's main panes.
//
// The detail pane is capped at 100 columns regardless of terminal width —
// long prose lines past ~80-100 chars hurt readability (the eye loses its
// place during the saccade back to the next line start). At terminal widths
// above the cap the surplus flows back into the thread list, which CAN
// usefully absorb more horizontal space (sender, date, subject all benefit).
//
// Tiers (chosen by total terminal columns):
//
//   Compact      ≤ 120 cols:  sidebar=22, threadList min, detail = rest
//   Comfortable  121-180:     sidebar=24, threadList=44, detail capped 100
//   Wide         ≥ 181:       sidebar=28, detail=100, surplus → threadList (cap 80)
//
// Border + padding overhead per pane is ~4 cols (border + paddingX=1 either
// side). The widths returned here are the OUTER pane widths (the value you
// pass to <Box width={...}>); inner content has 4 fewer cols.

export interface PaneWidths {
  sidebar: number;
  threadList: number;
  detail: number;
}

/** Maximum readable line length for the message-detail pane. */
export const DETAIL_MAX_WIDTH = 100;

/** Minimum total terminal width below which the layout starts squeezing. */
export const COMPACT_BREAKPOINT = 120;
/** Above this width the detail pane stops growing and surplus flows to the thread list. */
export const WIDE_BREAKPOINT = 180;

/** Hard floor — below this we still try to render but acknowledge the layout will be cramped. */
const THREADLIST_MIN = 32;
const DETAIL_MIN = 50;

/**
 * Compute outer pane widths for the four-pane drill-down layout.
 *
 * @param totalCols process.stdout.columns (or whatever the live terminal reports)
 */
export function computeLayout(totalCols: number): PaneWidths {
  // Guard: in rare cases (early boot, headless smoke runs) the terminal may
  // report 0 or undefined; treat as a sensible default desktop terminal.
  const cols = totalCols && totalCols > 0 ? totalCols : 180;

  if (cols <= COMPACT_BREAKPOINT) {
    // Compact: every column matters. Sidebar gets a tight 22, detail takes
    // whatever's left (which is the lion's share since MessageListPane
    // is now a horizontal pill row inside the detail column).
    const sidebar = 22;
    // Below SIDEBAR_MIN + THREADLIST_MIN + DETAIL_MIN = 100 we hit floors.
    const remaining = Math.max(THREADLIST_MIN + DETAIL_MIN, cols - sidebar);
    // 35/65 split favouring detail since reading IS the primary action.
    const threadList = Math.max(THREADLIST_MIN, Math.floor(remaining * 0.35));
    const detail = Math.max(DETAIL_MIN, remaining - threadList);
    return { sidebar, threadList, detail };
  }

  if (cols <= WIDE_BREAKPOINT) {
    // Comfortable: detail allowed to grow up to the cap; thread list takes
    // a moderate 44 cols (room for sender 22 + subject 18 + date 8); the
    // rest goes to detail.
    const sidebar = 24;
    const threadList = 44;
    const detail = Math.min(DETAIL_MAX_WIDTH, cols - sidebar - threadList);
    return { sidebar, threadList, detail: Math.max(DETAIL_MIN, detail) };
  }

  // Wide: detail pegged at the readable cap; surplus flows into the thread
  // list (cap 80 because beyond that the column just visually drifts off
  // the user's natural reading zone).
  const sidebar = 28;
  const detail = DETAIL_MAX_WIDTH;
  const surplus = cols - sidebar - detail;
  const threadList = Math.min(80, Math.max(THREADLIST_MIN, surplus));
  return { sidebar, threadList, detail };
}
