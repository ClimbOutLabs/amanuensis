'use client';

import { useRef, type KeyboardEvent } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { tablistTargetIndex } from '@/atoms/lib/tablistKeys.js';

/**
 * The memory sub-tab pattern: an underlined tablist shared by the standalone memory page
 * and the Settings Memory section, so both surfaces navigate the same way. Arrow keys move
 * between tabs (focus follows the selection), Home and End jump to the ends, and only the
 * selected tab is in the tab order.
 */
export function MemoryTabs<TabId extends string>(props: {
  ariaLabel: string;
  tabs: ReadonlyArray<{ id: TabId; label: string }>;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = props.tabs.findIndex(tab => tab.id === props.activeTab);
    const next = tablistTargetIndex({ key: event.key, current, count: props.tabs.length });
    if (next === null) return;
    const tab = props.tabs[next];
    if (tab === undefined) return;
    event.preventDefault();
    props.onTabChange(tab.id);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={props.ariaLabel}
      className="flex gap-1 border-b border-border"
      onKeyDown={onKeyDown}
    >
      {props.tabs.map((item, index) => (
        <button
          key={item.id}
          ref={element => {
            buttonRefs.current[index] = element;
          }}
          type="button"
          role="tab"
          aria-selected={props.activeTab === item.id}
          tabIndex={props.activeTab === item.id ? 0 : -1}
          onClick={() => props.onTabChange(item.id)}
          className={cn(
            'px-3 py-2 text-sm font-medium',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring',
            props.activeTab === item.id
              ? 'border-b-2 border-primary-button-bg text-text-primary'
              : 'text-text-secondary',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
