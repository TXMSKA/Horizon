// The themes of Horizon's boards live in `horizon.mjs` (AMBER and DAYLIGHT,
// the same values as `src/tokens.css`) and repaint each window through its
// `theme`. This skin only brings what a theme cannot: the faces, all of them
// fonts that ship with Windows, and the gradients of the tab groups' colour
// picker.

import { PLAIN, SANS, MONO, pick } from "blueprint/skins.mjs";

const FACES = {
  mono: MONO,
  serif: 'Georgia, "Times New Roman", serif',
  display: '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
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
 * The tab groups' colour picker: white to the hue across, clear to black
 * down, and the hue strip. The viewer asks for the defs once with the prefix
 * "rv", so a theme names them as `url(#rv-hz-...)`.
 */
export function skinDefs(prefix) {
  const ids = { prefix, shadow: `${prefix}-shadow`, mesh: `${prefix}-mesh`, dots: `${prefix}-dots` };
  const svg =
    `<linearGradient id="${prefix}-hz-sv-hue" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#00c2a0"/></linearGradient>` +
    `<linearGradient id="${prefix}-hz-sv-dark" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000"/></linearGradient>` +
    `<linearGradient id="${prefix}-hz-hue" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#ff0000"/><stop offset="0.17" stop-color="#ffff00"/><stop offset="0.33" stop-color="#00ff00"/><stop offset="0.5" stop-color="#00ffff"/><stop offset="0.67" stop-color="#0000ff"/><stop offset="0.83" stop-color="#ff00ff"/><stop offset="1" stop-color="#ff0000"/></linearGradient>` +
    `<pattern id="${ids.dots}" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1" fill="#d0d0d0"/></pattern>`;
  return { ids, svg };
}
