// Horizon's window as the owner approved it on 2026-10-01: Familia Nebula's chrome
// with the Clear night start page, in the softer Amber and Daylight themes and
// the two high-contrast themes. Shared by every board of this repository so a
// screen is drawn once.

import { box, col, row, stack, text, icon, vector, space, fill } from "blueprint/kit.mjs";
import { badge, btn, dot, vr } from "blueprint/ui.mjs";

export const slug = (value) =>
  String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ---- themes ---------------------------------------------------------------

// Amber, approved by the owner on 2026-10-01 as Clear night's softer Amber: low-
// saturation warm greys stepped up from the canvas instead of near-black,
// off-white text and a muted amber. The title reads at about 14:1 on the page
// instead of 18:1; every text role stays at 4.5:1 or more on every surface and
// the frame at 3:1, checked with a script.
export const AMBER = {
  canvas: "#0d0c0b", surface: "#1c1a18", "surface-2": "#22201e", "surface-3": "#2b2826",
  glass: "rgba(18, 17, 16, 0.9)", hover: "#1b1917",
  "border-subtle": "#242120", line: "#302c29", "line-strong": "#46403c", frame: "#82786f",
  title: "#ece4dc", text: "#d3cac1", soft: "#a69c92", dim: "#9b9187",
  primary: "#dda15a", "primary-hover": "#e6b273", "on-primary": "#1a130b",
  wash: "#2a2117", "on-wash": "#f0c890", "primary-border": "rgba(221, 161, 90, 0.4)",
  error: "#e5938c", "error-wash": "#2b1a19", success: "#8fc7a0", warning: "#d9b770", info: "#a3b2dc",
  overlay: "rgba(0, 0, 0, 0.6)", shadow: "#000000", "cover-from": "#46403c", "cover-to": "#121110", white: "#ece4dc", none: "none",
  chrome: "#121110", page: "#171514", sky: "#171514", ground: "#11100f", horizon: "#dda15a", sun: "#dda15a",
  field: "#201e1c", "field-line": "#322e2b",
};

// Daylight, Amber's light counterpart, derived by job with the light-theme
// recipe (HIVEM1ND knowledge/design/light-themes.md), never inverted, and dimmed
// at the owner's request ("menos saturación y contraste, el blanco es muy fuerte").
// Neutrals sit at Amber's own warm-grey hue with almost no chroma; the floor is
// around L 0.94 and nothing is brighter than L 0.96, so no surface reads as
// white; raised fields are one step lighter than the floor and the chrome one
// step darker. Text is soft: title about 10:1, body about 8:1, every role at
// 4.5:1 or more on its lowest surface. No orange sits on white (the owner's rule for
// light themes): the accent is a low-saturation umber on small marks, and the
// horizon line is a warm pencil grey.
export const DAYLIGHT = {
  canvas: "#eeebe9", surface: "#f4f2f0", "surface-2": "#e1dedb", "surface-3": "#ddd9d6",
  glass: "rgba(232, 228, 226, 0.9)", hover: "#e4e1df",
  "border-subtle": "#dcd9d7", line: "#d6d3d0", "line-strong": "#c2bdb9", frame: "#7d7873",
  title: "#3b3631", text: "#48433e", soft: "#5b5551", dim: "#615b56",
  primary: "#63442e", "primary-hover": "#573b28", "on-primary": "#f4f2f0",
  wash: "#e6ded8", "on-wash": "#573b28", "primary-border": "rgba(99, 68, 46, 0.3)",
  error: "#8a3a36", "error-wash": "#efe1df", success: "#315e41", warning: "#6c4b25", info: "#3e5082",
  overlay: "rgba(59, 54, 49, 0.24)", shadow: "#cdc8c3", "cover-from": "#e1dedb", "cover-to": "#f4f2f0", white: "#f4f2f0", none: "none",
  chrome: "#e8e4e2", page: "#eeebe9", sky: "#eeebe9", ground: "#ebe8e6", horizon: "#a59d96", sun: "#63442e",
  field: "#f4f2f0", "field-line": "#d6d3d0",
};

// The accessibility option the owner asked for, in pure black and pure white: text at
// 15:1 or more, a bright amber on black or a deep umber on white as the accent
// (no orange on white, as in Daylight), and an `outline` so the profile
// control, the active tab and the address bar keep an edge where their fills
// would vanish.
export const CONTRAST_DARK = {
  canvas: "#000000", surface: "#000000", "surface-2": "#141414", "surface-3": "#262626",
  glass: "rgba(0, 0, 0, 0.92)", hover: "#1f1f1f",
  "border-subtle": "#6b6b6b", line: "#9e9e9e", "line-strong": "#ffffff", frame: "#ffffff", outline: "#ffffff",
  title: "#ffffff", text: "#ffffff", soft: "#e0e0e0", dim: "#c7c7c7",
  primary: "#ffb84d", "primary-hover": "#ffc875", "on-primary": "#000000",
  wash: "#2e2000", "on-wash": "#ffd699", "primary-border": "#ffb84d",
  error: "#ff9e9e", "error-wash": "#2e0a0a", success: "#8ff0b4", warning: "#ffe066", info: "#b3c7ff",
  overlay: "rgba(0, 0, 0, 0.8)", shadow: "#000000", "cover-from": "#262626", "cover-to": "#000000", white: "#ffffff", none: "none",
  chrome: "#000000", page: "#000000", sky: "#000000", ground: "#000000", horizon: "#ffb84d", sun: "#ffb84d",
  field: "#000000", "field-line": "#ffffff",
};

export const CONTRAST_LIGHT = {
  canvas: "#ffffff", surface: "#ffffff", "surface-2": "#f0f0f0", "surface-3": "#e0e0e0",
  glass: "rgba(255, 255, 255, 0.92)", hover: "#ebebeb",
  "border-subtle": "#767676", line: "#595959", "line-strong": "#000000", frame: "#000000", outline: "#000000",
  title: "#000000", text: "#000000", soft: "#262626", dim: "#3d3d3d",
  primary: "#5a3117", "primary-hover": "#432610", "on-primary": "#ffffff",
  wash: "#f5ede7", "on-wash": "#432610", "primary-border": "#5a3117",
  error: "#a3001b", "error-wash": "#fde8ea", success: "#0a5c2c", warning: "#6b4a00", info: "#1d4592",
  overlay: "rgba(0, 0, 0, 0.4)", shadow: "#000000", "cover-from": "#f0f0f0", "cover-to": "#ffffff", white: "#ffffff", none: "none",
  chrome: "#ffffff", page: "#ffffff", sky: "#ffffff", ground: "#ffffff", horizon: "#000000", sun: "#5a3117",
  field: "#ffffff", "field-line": "#000000",
};

// ---- the mark -------------------------------------------------------------

// The start page's sun: an outline half circle sitting on the horizon. A vector
// box twice as wide as tall turns the arc's radii (50 by 100 on the grid) into a
// true half circle.
export const ARC = "M0 100 A50 100 0 0 1 100 100";

/**
 * The mark without its tile, for Horizon's own surfaces (the app icon keeps the
 * tile for everything the system shows). Drawn by the `hz-mark` node in
 * extra-nodes.mjs in the theme's title and primary colours; `size` is its height.
 */
export const mark = (size) => ({ t: "hz-mark", size, name: "mark", label: "Horizon mark" });

/** The app icon as delivered: the mark on the dark Amber tile. */
export const appIcon = (size, name = "app-icon") => ({ t: "hz-icon", size, name, label: "Horizon app icon" });

// ---- the window -----------------------------------------------------------

// A tab marked `own` is one of Horizon's own pages and leads with the mark (the owner, 2026-10-01).
export const TABS = [
  { title: "Home", own: true },
  { title: "Sourdough bread: the complete guide", color: "#745642", initial: "S" },
  { title: "Routes through Patagonia in autumn", color: "#3a7bc9", initial: "R" },
];

export function tabLead(tab, on) {
  if (tab.own) return { t: "hz-mark", size: 16 };
  return tab.glyph
    ? icon(tab.glyph, { size: 14, color: on ? "primary" : "soft" })
    : badge(tab.color, { initial: tab.initial, size: 16, radius: 4 });
}

// A theme with an `outline` colour (the high-contrast ones) draws the edges
// that its fills alone would not show: the profile control, the active tab and
// the address bar. The other themes pass nothing and draw as approved.
export function profile({ outline } = {}) {
  return row(
    { h: 30, pad: [0, 10], gap: 8, radius: "md", fill: "surface-2", stroke: outline, name: "profile", label: "Profile: Personal" },
    dot("primary", 8),
    text("Personal", { size: "xs", weight: 600, color: "title" }),
    icon("chevronDown", { size: 12, color: "soft" }),
  );
}

export function windowControls() {
  return row(
    { h: 44, name: "window-controls", label: "Minimize, maximize and close" },
    ...["minus", "square", "x"].map((glyph) => stack({ w: 46, h: 44 }, icon(glyph, { size: glyph === "square" ? 12 : 15, color: "soft", place: "center" }))),
  );
}

/** `#rrggbb` as `rgba()` at the given opacity, for a group's tinted label. */
const tint = (hex, alpha) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${alpha})`;

/** A tab group's label: its icon and name in its own colour. */
export function groupLabel(group) {
  return row(
    { h: 26, pad: [0, 10], gap: 6, radius: "md", fill: tint(group.color, 0.16), name: `group-${slug(group.name)}`, label: `Group: ${group.name}` },
    icon(group.glyph, { size: 13, color: group.color }),
    text(group.name, { size: "xs", weight: 650, color: group.color }),
  );
}

/**
 * The tab strip. A tab naming a `group` (a key of `groups`, each with a name,
 * a colour and a glyph) is drawn after its group's label, and the group's
 * tabs share one underline in its colour.
 */
export function tabStrip({ tabs = TABS, active = 0, groups = {}, tabW = 224, outline } = {}) {
  const tabNode = (tab, i) => {
    const on = i === active;
    return row(
      { w: tabW, h: 32, pad: [0, 8, 0, 10], gap: 8, radius: "md", fill: on ? "page" : undefined, stroke: on ? outline : undefined, name: `tab-${slug(tab.title)}`, label: tab.title },
      tabLead(tab, on),
      text(tab.title, { size: "xs", weight: on ? 600 : 500, color: on ? "title" : "soft", lines: 1, grow: 1 }),
      icon("x", { size: 13, color: "dim" }),
    );
  };
  const runs = [];
  tabs.forEach((tab, i) => {
    const last = runs[runs.length - 1];
    if (tab.group && last?.group === tab.group) last.nodes.push(tabNode(tab, i));
    else runs.push({ group: tab.group, nodes: [tabNode(tab, i)] });
  });
  return row(
    { h: 44, pad: [0, 0, 0, 10], gap: 6, fill: "chrome", name: "tabs", label: "Tabs" },
    profile({ outline }),
    vr(20),
    ...runs.map(({ group, nodes }) => {
      const def = group && groups[group];
      if (!def) return nodes;
      return row({ pad: [2, 0, 2, 0], gap: 6, edge: { side: "bottom", color: def.color, width: 2 } }, groupLabel(def), ...nodes);
    }),
    btn("plus", { size: 28, g: 16, label: "New tab" }),
    fill(),
    windowControls(),
  );
}

/**
 * The address bar: the placeholder, or a typed `value` with the caret when
 * `focus` is set; `blocked` is the count beside the shield (none on Horizon's own pages), `starred` fills
 * the star.
 */
export function address({ value, focus = false, blocked = 14, starred = false, outline } = {}) {
  return row(
    { grow: 1, h: 36, pad: [0, 14], gap: 10, radius: "pill", fill: "surface-2", stroke: focus ? "primary" : outline, strokeWidth: focus ? 1.5 : 1, name: "address", label: "Address bar" },
    stack({ w: 16, h: 16, name: "shield", label: "Blocking on this site" }, icon("shieldCheck", { size: 16, color: "primary" })),
    row(
      { gap: 1 },
      text(value ?? "Search or enter an address", { size: "sm", color: value ? "title" : "dim" }),
      focus ? box({ w: 1.5, h: 18, fill: "primary" }) : null,
    ),
    fill(),
    blocked == null ? null : text(`${blocked} blocked`, { size: "xs", color: "soft" }),
    icon("star", { size: 16, color: starred ? "primary" : "soft", filled: starred }),
  );
}

export function toolbar({ bar, outline } = {}) {
  return row(
    { h: 52, pad: [0, 12], gap: 4, fill: "chrome", edge: { side: "bottom", color: "line" }, name: "toolbar", label: "Toolbar" },
    btn("arrowLeft", { label: "Back" }),
    btn("arrowRight", { label: "Forward", tone: "dim" }),
    btn("rotateCw", { label: "Reload" }),
    space(6),
    address({ ...bar, outline }),
    space(6),
    btn("notebookPen", { label: "Notebooks" }),
    btn("sparkles", { label: "Lyra", tone: "primary" }),
    btn("ellipsis", { label: "Menu" }),
  );
}

/**
 * The standalone window, painted with one theme. `tabs`, `active`, `groups`
 * and `tabW` set the tab strip, `bar` the address bar, `side` a panel docked
 * on the right of the page, and `overlays` popovers placed over the whole
 * window.
 */
export function horizonWindow(theme, page, { tabs, active, groups, tabW, bar, side, overlays, label = "Start page" } = {}) {
  const outline = theme.outline ? "outline" : undefined;
  const content = stack({ grow: 1, clip: true, fill: "page", name: "start-page", label }, ...page);
  const body = side ? row({ grow: 1, align: "stretch" }, content, side) : content;
  const frame = col({ h: 900, fill: "page", theme: overlays ? undefined : theme, name: "window", label: "Horizon window" }, tabStrip({ tabs, active, groups, tabW, outline }), toolbar({ bar, outline }), body);
  return overlays ? stack({ h: 900, theme }, frame, ...overlays) : frame;
}

// ---- start-page pieces ----------------------------------------------------

export function search({ w = 640, h = 52, radius = "pill" } = {}) {
  return row(
    { w, h, pad: [0, 18], gap: 12, radius, fill: "field", stroke: "field-line", name: "search", label: "Search" },
    icon("search", { size: 18, color: "soft" }),
    text("Search the web or enter an address", { size: "base", color: "dim" }),
    fill(),
    icon("sparkles", { size: 18, color: "primary" }),
  );
}

export function lyra() {
  return row(
    { gap: 8, name: "lyra", label: "Ask Lyra" },
    icon("sparkles", { size: 16, color: "primary" }),
    text("Ask Lyra about what you have open", { size: "sm", color: "text" }),
  );
}

export const SITES = ["Wikipedia", "YouTube", "Maps", "News", "Mail"];

export const NOTES = [
  { title: "Route 40: gravel sections and fuel stops", source: "rutasdelsur.example" },
  { title: "El Chaltén in April: open trails", source: "screenshot" },
  { title: "Budget: accommodation and car", source: "personal note" },
];

export function noteRow(note, { source = true } = {}) {
  return row(
    { h: 50, gap: 12, edge: { side: "bottom", color: "line" }, name: `note-${slug(note.title)}`, label: note.title },
    icon(note.source === "screenshot" ? "camera" : "fileText", { size: 16, color: "soft" }),
    text(note.title, { size: "sm", color: "title", lines: 1, grow: 1 }),
    source ? text(note.source, { size: "xs", color: "dim", face: "mono", lines: 1 }) : null,
  );
}

// ---- the start page -------------------------------------------------------

/**
 * The approved start page, Clear night: the sky above the horizon line is for
 * browsing, with the name, the search and the shortcuts (kept under the search
 * at the owner's choice); the ground below it is for research, with the notebook to
 * resume and Lyra. The sun sits on the line.
 */
export function startPage() {
  return stack(
    { w: 1440, h: 804, place: { x: 0, y: 0 } },
    box({ w: 1440, h: 420, fill: "sky", place: { x: 0, y: 0 } }),
    box({ w: 1440, h: 384, fill: "ground", place: { x: 0, y: 420 } }),
    box({ w: 1440, h: 1, fill: "horizon", place: { x: 0, y: 420 } }),
    vector({ d: ARC, w: 64, h: 32, stroke: "sun", strokeWidth: 1.5, place: { x: 688, y: 388 } }),
    col(
      { w: 700, gap: 24, align: "center", place: { x: 370, y: 150 } },
      text("Horizon", { face: "display", size: 30, weight: 600, color: "title", track: 0.04 }),
      search({ w: 700 }),
      row({ gap: 24, justify: "center" }, ...SITES.map((site) => text(site, { size: "sm", color: "soft", name: `shortcut-${slug(site)}`, label: site }))),
    ),
    col(
      { w: 700, gap: 0, place: { x: 370, y: 470 } },
      row(
        { h: 36, gap: 10, name: "resume", label: "Continue with Trip to Patagonia" },
        icon("notebookPen", { size: 16, color: "primary" }),
        text("Trip to Patagonia", { size: "base", weight: 600, color: "title" }),
        fill(),
        text("6 notes, yesterday", { size: "xs", color: "soft" }),
      ),
      ...NOTES.map((note) => noteRow(note)),
      space(22),
      lyra(),
    ),
  );
}
