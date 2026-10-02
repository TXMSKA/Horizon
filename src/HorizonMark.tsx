// The mark without its tile marks Horizon's own pages; the tile belongs to what the system shows.
// Same geometry as assets/icon/horizon-mark.svg, painted with the theme's title and accent colours.
export function HorizonMark() {
  return <svg className="horizon-mark" viewBox="294.46 135.2 435.08 753.61" aria-hidden="true" focusable="false">
    <path className="horizon-mark-sun" d="M417.68 341.83 A194.56 194.56 0 0 1 606.32 682.17 Z" />
    <g className="horizon-mark-ink" fill="none" strokeLinecap="round">
      <circle cx="512" cy="512" r="194.56" strokeWidth="38.91" />
      <path d="M430.43 437.09 L356.06 478.32" strokeOpacity="0.6" strokeWidth="11.67" />
      <path d="M464.39 498.35 L358.89 556.83" strokeOpacity="0.6" strokeWidth="11.67" />
      <path d="M498.35 559.61 L392.85 618.09" strokeOpacity="0.6" strokeWidth="11.67" />
      <path d="M532.31 620.87 L457.93 662.1" strokeOpacity="0.6" strokeWidth="11.67" />
      <path d="M313.92 154.65 L710.08 869.35" strokeWidth="38.91" />
    </g>
  </svg>;
}
