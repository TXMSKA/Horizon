// Horizon's visual identity. The owner picked Claro's layout in Amber and Daylight
// on 2026-10-01, then, the same day, moved to Clear night's start page in
// softer, less saturated themes with a high-contrast option in pure black and
// pure white (his comment on this board). The themes and the start page live
// in ../kit/horizon.mjs so every board draws the same window; the directions
// he set aside were removed. The data is invented.

import { board } from "blueprint/board.mjs";
import { AMBER, CONTRAST_DARK, CONTRAST_LIGHT, DAYLIGHT, horizonWindow, startPage } from "../kit/horizon.mjs";

const home = (theme) => horizonWindow(theme, [startPage()]);

export default board({
  id: "identity",
  title: "Visual identity",
  note: "Familia Nebula's chrome with the Clear night start page: the softer Amber and Daylight themes in the first row, the high-contrast option in pure black and pure white in the second. Daylight waits for the owner's review. Click a screen for its note. The data is invented.",
  screens: [
    { id: "elegido-amber", title: "Amber (dark)", col: 0, row: 0, root: () => home(AMBER), note: "Approved: warm greys instead of near-black, off-white text at about 14:1 and a muted amber. Every text reaches 4.5:1." },
    { id: "elegido-daylight", title: "Daylight (light), to review", col: 1, row: 0, root: () => home(DAYLIGHT), note: "Amber's light counterpart, derived by job, not inverted, and dimmed: no surface brighter than a soft off-white, text at about 10:1 for titles and 8:1 for body, and no orange on white. The accent is a low-saturation umber on small marks; the horizon is a warm pencil grey." },
    { id: "high-contrast-dark", title: "High contrast: dark", col: 0, row: 1, root: () => home(CONTRAST_DARK), note: "Approved: pure black and pure white, text at 15:1 or more, edges on the controls." },
    { id: "high-contrast-light", title: "High contrast: light", col: 1, row: 1, root: () => home(CONTRAST_LIGHT), note: "Pure white and pure black, with the same deep umber as Daylight for the accent." },
  ],
});
