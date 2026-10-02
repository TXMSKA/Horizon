// Horizon's mark and app icon as node types, drawn from the vector Cosmic made of
// The owner's sketch (assets/icon/horizon-icon.svg, 2026-10-01): a circle cut through its
// centre by a line at 61 degrees that runs on 2.1 radii each way, the lit half
// filled, four straight hatch strokes square to the line on the other half.

const MARK = {
  half: "M417.68 341.83 A194.56 194.56 0 0 1 606.32 682.17 Z",
  hatches: [
    "M430.43 437.09 L356.06 478.32",
    "M464.39 498.35 L358.89 556.83",
    "M498.35 559.61 L392.85 618.09",
    "M532.31 620.87 L457.93 662.10",
  ],
  line: "M313.92 154.65 L710.08 869.35",
};
// The mark's own box on the icon's 1024 grid, round caps included.
const BOX = { x: 294.46, y: 135.2, w: 435.08, h: 753.61 };

function markSvg(ink, sun) {
  return (
    `<path d="${MARK.half}" fill="${sun}"/>` +
    `<g fill="none" stroke="${ink}" stroke-linecap="round">` +
    `<circle cx="512" cy="512" r="194.56" stroke-width="38.91"/>` +
    MARK.hatches.map((d) => `<path d="${d}" stroke-opacity="0.6" stroke-width="11.67"/>`).join("") +
    `<path d="${MARK.line}" stroke-width="38.91"/></g>`
  );
}

export default {
  // The bare mark in the theme's own colours: `size` is its height. Ink and sun
  // default to the title and primary roles, so a light theme draws it without
  // orange on white.
  "hz-mark": {
    measure(node) {
      node._h = node.size;
      node._w = (node.size * BOX.w) / BOX.h;
    },
    draw(node, g) {
      const k = node._h / BOX.h;
      g.out.push(`<g transform="translate(${node._x - BOX.x * k} ${node._y - BOX.y * k}) scale(${k})">${markSvg(g.paint(node.ink ?? "title"), g.paint(node.sun ?? "primary"))}</g>`);
    },
  },
  // The app icon as delivered: the mark on the dark Amber tile, whatever theme
  // surrounds it.
  "hz-icon": {
    measure(node) {
      node._w = node.size;
      node._h = node.size;
    },
    draw(node, g) {
      const k = node.size / 1024;
      const face = g.uid("hz-face");
      g.out.push(
        `<g transform="translate(${node._x} ${node._y}) scale(${k})">` +
          `<defs><linearGradient id="${face}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2826"/><stop offset="1" stop-color="#1c1a18"/></linearGradient></defs>` +
          `<rect width="1024" height="1024" rx="240.64" fill="url(#${face})"/>` +
          markSvg("#ece4dc", "#dda15a") +
          `</g>`,
      );
    },
  },
};
