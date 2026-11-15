import type { FC, ReactNode } from 'react';

import { Icon } from '../icons/Icon.js';

/** One folded row of the panel: a label with its chevron on the left, closed by default. */
export const RailFoldedRow: FC<{ section: string; title: string; children: ReactNode }> = ({
  section,
  title,
  children,
}) => (
  <details className="aman-runtime-rail__details" data-section={section}>
    <summary className="aman-runtime-rail__details-summary">
      <Icon name="chevron-right" size={12} className="aman-runtime-rail__fold-chevron" aria-hidden="true" />
      <span>{title}</span>
    </summary>
    <div className="aman-runtime-rail__details-body">{children}</div>
  </details>
);
