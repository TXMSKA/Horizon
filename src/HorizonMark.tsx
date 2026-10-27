// The mark without its tile marks Horizon's own pages; the tile belongs to what the system shows.
// Same geometry as assets/icon/horizon-mark.svg, painted with the theme's title and accent colours.
export function HorizonMark() {
  return <svg className="horizon-mark" viewBox="294.46 135.2 435.08 753.61" aria-hidden="true" focusable="false">
    <path className="horizon-mark-sun" d="M417.68 341.83 A194.56 194.56 0 0 1 606.32 682.17 Z" />
    <g className="horizon-mark-ink" fill="none" strokeLinecap="round">
      <circle cx="512" cy="512" r="194.56" strokeWidth="38.91" />
      <path d="M313.92 154.65 L710.08 869.35" strokeWidth="38.91" />
    </g>
  </svg>;
}
