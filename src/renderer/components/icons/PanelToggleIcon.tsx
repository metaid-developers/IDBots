import React from 'react';

/**
 * The panel toggle's chevron. It points at where the click sends the middle
 * column: collapsed → LEFT (the column re-opens into the space on the left of
 * the boundary), expanded → RIGHT (the column gives that space back to the
 * right pane). One icon, two directions — it replaces the retired "sidebar
 * frame" glyph whose folded/unfolded divider line no longer meant anything.
 */
const PanelToggleIcon: React.FC<{ className?: string; collapsed: boolean }> = ({ className, collapsed }) => (
  <svg
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {collapsed ? <path d="M9.5 3.5 5 8l4.5 4.5" /> : <path d="M6.5 3.5 11 8l-4.5 4.5" />}
  </svg>
);

export default PanelToggleIcon;
