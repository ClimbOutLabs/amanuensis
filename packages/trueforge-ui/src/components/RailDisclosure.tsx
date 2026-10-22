'use client';

import { useId, type FC, type ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';

type RailDisclosureProps = {
  /** Names the section for tests and the stylesheet; becomes `data-section`. */
  section: string;
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Shown after the title in the secondary colour, e.g. "· 9". */
  count?: string | undefined;
  /** A gold dot after the count, for something in the section that needs a look. */
  attention?: boolean;
  /** A second line under the title, in the secondary colour. */
  detail?: string | undefined;
  children: ReactNode;
};

/**
 * One folded section of the rail. The whole header is the toggle, so the title, count and detail
 * are all one keyboard stop. The body is left out of the page while folded.
 */
export const RailDisclosure: FC<RailDisclosureProps> = ({
  section,
  title,
  open,
  onToggle,
  count,
  attention = false,
  detail,
  children,
}) => {
  const panelId = useId();
  return (
    <section className="aman-runtime-rail__section" data-section={section}>
      <button
        type="button"
        className="aman-runtime-rail__disclosure"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
      >
        <span className="aman-runtime-rail__disclosure-head">
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            size={14}
            className="aman-runtime-rail__chevron"
            aria-hidden="true"
          />
          <span className="aman-runtime-rail__disclosure-title">{title}</span>
          {count === undefined ? null : <span className="aman-runtime-rail__disclosure-count">{count}</span>}
          {attention ? (
            <span className="aman-runtime-rail__attention" role="img" aria-label="A recent action failed" />
          ) : null}
        </span>
        {detail === undefined ? null : <span className="aman-runtime-rail__disclosure-detail">{detail}</span>}
      </button>
      {open ? (
        <div id={panelId} className="aman-runtime-rail__disclosure-body">
          {children}
        </div>
      ) : null}
    </section>
  );
};
