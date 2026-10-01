// Horizon has no design tokens yet: its identity is being chosen on the
// identity board, where every variant repaints its window through a `theme`.
// This skin only brings what a theme cannot: the faces the variants are set
// in, all of them fonts that ship with Windows, and the gradients of the
// dawn variants.

import { PLAIN, SANS, MONO, pick } from "blueprint/skins.mjs";

const FACES = {
  mono: MONO,
  serif: 'Georgia, "Times New Roman", serif',
  display: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
  bahn: 'Bahnschrift, "Segoe UI", system-ui, sans-serif',
};

export const skins = {
  design: {
    id: "design",
    shadow: false,
    color: (role) => pick(PLAIN, role),
    face: (face) => FACES[face] ?? SANS,
    weight: (face, weight) => weight,
    image(node, r) {
      const { _x: x, _y: y, _w: w, _h: h } = node;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${PLAIN["surface-3"]}"/>`;
    },
  },
};

/**
 * The dawn skies and the rising sun. The viewer asks for the defs once with
 * the prefix "rv", so a theme names them as `url(#rv-hz-...)`.
 */
export function skinDefs(prefix) {
  const ids = { prefix, shadow: `${prefix}-shadow`, mesh: `${prefix}-mesh`, dots: `${prefix}-dots` };
  const svg =
    `<linearGradient id="${prefix}-hz-a1-sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#ffd2b6"/><stop offset="0.55" stop-color="#ffe6d6"/><stop offset="1" stop-color="#fff8f2"/></linearGradient>` +
    `<linearGradient id="${prefix}-hz-a2-sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#1b1830"/><stop offset="0.5" stop-color="#3b2448"/><stop offset="0.8" stop-color="#8e3f52"/><stop offset="1" stop-color="#e0844b"/></linearGradient>` +
    `<radialGradient id="${prefix}-hz-a3-sun" cx="0.5" cy="1" r="1">` +
    `<stop offset="0" stop-color="#ffb98a"/><stop offset="0.5" stop-color="#ffdcc3"/><stop offset="1" stop-color="#faf7f3"/></radialGradient>` +
    `<pattern id="${ids.dots}" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1" fill="#d0d0d0"/></pattern>`;
  return { ids, svg };
}
