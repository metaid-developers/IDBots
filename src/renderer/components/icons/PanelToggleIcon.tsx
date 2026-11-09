import React from 'react';

/**
 * The seam toggle's chevron (接缝按钮双向化 2026-11-09). `direction` is the
 * direction the seam itself will MOVE on click — LEFT: the seam travels left
 * (the middle column collapses into the rail side, or the browser re-opens
 * from a right-collapsed shell); RIGHT: the seam travels right (the middle
 * column re-opens from a left-collapsed shell, or the browser collapses so
 * the conversation fills). One glyph, one meaning, both faces — it replaces
 * the retired "sidebar frame" glyph whose folded/unfolded divider line no
 * longer meant anything.
 */
const PanelToggleIcon: React.FC<{ className?: string; direction: 'left' | 'right' }> = ({ className, direction }) => (
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
    {direction === 'left' ? <path d="M9.5 3.5 5 8l4.5 4.5" /> : <path d="M6.5 3.5 11 8l-4.5 4.5" />}
  </svg>
);

export default PanelToggleIcon;
