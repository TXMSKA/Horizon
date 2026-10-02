// Horizon's visual identity. The owner picked Claro's layout in Amber and Daylight
// on 2026-10-01, then, the same day, moved to Clear night's start page in
// softer, less saturated themes with a high-contrast option in pure black and
// pure white (his comment on this board). The app icon is the mark Cosmic drew
// from the owner's sketch. The themes, the start page and the mark live in
// ../kit/horizon.mjs so every board draws the same window; the directions he set
// aside were removed. The data is invented.

import { board } from "blueprint/board.mjs";
import { col, row, stack, text } from "blueprint/kit.mjs";
import { AMBER, CONTRAST_DARK, CONTRAST_LIGHT, DAYLIGHT, appIcon, horizonWindow, mark, startPage } from "../kit/horizon.mjs";

const home = (theme) => horizonWindow(theme, [startPage()]);

const caption = (value, props = {}) => text(value, { size: "sm", color: "soft", ...props });

/** One ground the bare mark sits on, in that theme's own colours. */
const ground = (theme, title) =>
  col(
    { gap: 10, align: "center" },
    stack({ w: 200, h: 200, radius: "lg", fill: "page", stroke: "line", theme, name: `mark-${title.toLowerCase().replace(/\s+/g, "-")}`, label: `Mark on ${title}` }, { ...mark(120), place: "center" }),
    caption(title, { size: "xs" }),
  );

/** Where each form of the mark goes: the tile for what the system shows, the bare mark inside Horizon. */
const icon = () =>
  stack(
    { w: 1440, h: 900, fill: "page", theme: AMBER, name: "icon-sheet", label: "App icon" },
    col(
      { w: 1200, gap: 8, place: { x: 120, y: 96 } },
      text("App icon", { size: 30, weight: 650, color: "title" }),
      caption("With its tile wherever the system or the outside world shows Horizon; without it on Horizon's own surfaces, in each theme's colours."),
    ),
    col(
      { w: 520, gap: 20, place: { x: 120, y: 240 } },
      text("With the tile", { size: "base", weight: 600, color: "title" }),
      row({ gap: 28, align: "end" }, appIcon(256, "icon-256"), appIcon(128, "icon-128"), appIcon(64, "icon-64"), appIcon(32, "icon-32"), appIcon(16, "icon-16")),
      caption("Window and taskbar, Start menu and desktop shortcut, installer, the downloads page, the Cosmic family image.", { lines: 3 }),
    ),
    col(
      { w: 640, gap: 20, place: { x: 700, y: 240 } },
      text("Without the tile", { size: "base", weight: 600, color: "title" }),
      row({ gap: 24 }, ground(AMBER, "Amber"), ground(DAYLIGHT, "Daylight")),
      row({ gap: 24 }, ground(CONTRAST_DARK, "High contrast dark"), ground(CONTRAST_LIGHT, "High contrast light")),
      caption("Settings and About headers and Horizon's own pages. Off-white and amber on dark grounds, ink and umber on light ones, so no orange sits on white.", { lines: 3 }),
    ),
  );

export default board({
  id: "identity",
  title: "Visual identity",
  note: "Familia Nebula's chrome with the Clear night start page: the softer Amber and Daylight themes in the first row, the high-contrast option in pure black and pure white in the second, and the app icon with where each form of the mark goes in the third. Click a screen for its note. The data is invented.",
  screens: [
    { id: "elegido-amber", title: "Amber (dark)", col: 0, row: 0, root: () => home(AMBER), note: "Approved: warm greys instead of near-black, off-white text at about 14:1 and a muted amber. Every text reaches 4.5:1." },
    { id: "elegido-daylight", title: "Daylight (light)", col: 1, row: 0, root: () => home(DAYLIGHT), note: "Approved: Amber's light counterpart, derived by job, not inverted, and dimmed: no surface brighter than a soft off-white, text at about 10:1 for titles and 8:1 for body, and no orange on white. The accent is a low-saturation umber on small marks; the horizon is a warm pencil grey." },
    { id: "high-contrast-dark", title: "High contrast: dark", col: 0, row: 1, root: () => home(CONTRAST_DARK), note: "Approved: pure black and pure white, text at 15:1 or more, edges on the controls." },
    { id: "high-contrast-light", title: "High contrast: light", col: 1, row: 1, root: () => home(CONTRAST_LIGHT), note: "Pure white and pure black, with the same deep umber as Daylight for the accent." },
    { id: "app-icon", title: "App icon", col: 0, row: 2, root: icon, note: "Cosmic's mark from the owner's sketch. With the tile for everything the system shows; without it inside Horizon, in each theme's colours." },
  ],
});
