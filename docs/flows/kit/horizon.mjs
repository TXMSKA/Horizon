// Horizon's window as the owner approved it on 2026-10-02: Familia Nebula's chrome
// with the Clear night start page, in the softer Amber and Daylight themes and
// the two high-contrast themes. Shared by every board of this repository so a
// screen is drawn once.

import { box, col, row, stack, text, icon, vector, space, fill, locate, SIZES } from "blueprint/kit.mjs";
import { badge, btn, dot, vr, seg, hr, action, label, popover, menuRow, select, input, switcher, checkbox } from "blueprint/ui.mjs";

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
export const SITE_COLORS = {
  "site-routes": "#2f6b4f", "site-inn": "#1f5f8b", "site-trails": "#5b7f3a",
  "site-map": "#397b83", "site-bread": "#956b2e", "site-ink": "#ffffff",
};

export const AMBER = {
  ...SITE_COLORS,
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
  ...SITE_COLORS,
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
  ...SITE_COLORS,
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
  ...SITE_COLORS,
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
  { title: "Sourdough bread: the complete guide", color: "site-bread", initial: "S" },
  { title: "Routes through Patagonia in autumn", color: "site-routes", initial: "R" },
];

export function tabLead(tab, on) {
  // The mark is narrower than a favicon; its 16 px slot keeps every tab title at one offset.
  if (tab.own) return stack({ w: 16, h: 16 }, { t: "hz-mark", size: 16, place: "center" });
  return tab.glyph
    ? icon(tab.glyph, { size: 14, color: on ? "primary" : "soft" })
    : badge(tab.color, { initial: tab.initial, size: 16, radius: "xs", ink: "site-ink" });
}

// A theme with an `outline` colour (the high-contrast ones) draws the edges
// that its fills alone would not show: the profile control, the active tab and
// the address bar. The other themes pass nothing and draw as approved.
export function profile({ outline } = {}) {
  return row(
    { h: 30, pad: [0, 10], gap: 8, radius: "md", fill: "surface-2", stroke: outline, name: "profile", label: "Profile: Personal" },
    dot("primary", 8),
    text("Personal", { size: "xs", weight: 600, color: "title" }),
    vr(16),
    icon("chevronDown", { size: 12, color: "soft" }),
  );
}

export function windowControls() {
  return row(
    { h: 44, name: "window-controls", label: "Minimize, maximize and close" },
    ...["minus", "square", "x"].map((glyph) => stack({ w: 46, h: 44 }, icon(glyph, { size: glyph === "square" ? 12 : 15, color: "soft", place: "center" }))),
  );
}

/** A tab group's label: its icon and name in its own colour. */
export function groupLabel(group) {
  return row(
    { h: 26, pad: [0, 10], gap: 6, radius: "md", fill: "wash", name: `group-${slug(group.name)}`, label: `Group: ${group.name}` },
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
    { grow: 1, h: 36, pad: [0, 14], gap: 10, radius: "xl", fill: "surface-2", stroke: focus ? "primary" : outline, strokeWidth: focus ? 1.5 : 1, name: "address", label: "Address bar" },
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

export const PAGE_H = 900 - 44 - 52 - 34;
export const PAGE_TOP = 44 + 52 + 34;
export const PINNED = [{ glyph: "scan", label: "Capture (Ctrl+Shift+S)", ref: "capture" }];

export function avatar({ outline, active = false, privateWindow = false } = {}) {
  if (privateWindow) return row(
    { h: 32, pad: [0, 8], gap: 6, radius: "pill", fill: "surface-2", stroke: outline, name: "avatar", label: "Private window" },
    icon("eyeOff", { size: 16, color: "soft" }), text("Private", { size: "xs", color: "title" }),
  );
  return stack(
    { w: 32, h: 32, radius: "md", fill: active ? "surface-3" : undefined, name: "avatar", label: "Account and profiles" },
    stack({ w: 28, h: 28, radius: "pill", fill: "surface-2", stroke: outline, place: "center" },
      text("AF", { size: "xs", weight: 650, color: "title", place: "center" })),
  );
}

export function toolbar({ bar, outline, pinned = PINNED, activeButton, privateWindow } = {}) {
  const button = (glyph, label, ref, tone) => btn(glyph, { label, ref, tone, active: activeButton === ref });
  return row(
    { h: 52, pad: [0, 12], gap: 4, fill: "chrome", name: "toolbar", label: "Toolbar" },
    btn("arrowLeft", { label: "Back" }), btn("arrowRight", { label: "Forward", tone: "dim" }),
    btn("rotateCw", { label: "Reload" }), space(6), address({ ...bar, outline }), space(6),
    button("puzzle", "Extensions", "extensions"), vr(20),
    ...pinned.map(({ glyph, label, ref }) => button(glyph, label, ref)),
    button("layoutGrid", "Hub", "hub"),
    avatar({ outline, active: activeButton === "avatar", privateWindow }),
    button("ellipsis", "Menu", "menu"),
    stack({ w: 32, h: 32, name: "lyra", label: "Lyra" },
      { ...badge("primary", { glyph: "sparkles", size: 30, ink: "on-primary" }), place: "center" }),
  );
}

export const FAVORITES = [
  { title: "Rutas del Sur", initial: "R", color: "site-routes" }, { title: "Trip", folder: true },
  { title: "Recipes", folder: true }, { title: "Lago Azul Inn", initial: "L", color: "site-inn" }, { title: "Maps", folder: true },
];
export function favoritesBar({ openFolder } = {}) {
  const item = ({ title, folder, initial, color }) => row(
    { h: 28, pad: [0, 8], gap: 6, radius: "sm", fill: openFolder === title ? "surface-3" : undefined,
      name: "favorite-" + slug(title), label: title },
    folder ? icon("folder", { size: 14, color: "soft" }) : badge(color, { initial, size: 16, radius: "xs", ink: "site-ink" }),
    text(title, { size: "xs", color: "text" }),
  );
  // Items sit at the bar's top: the toolbar already leaves room above them, so this balances the room below.
  return row({ h: 34, pad: [0, 12], gap: 6, align: "start", fill: "chrome", edge: { side: "bottom", color: "line" }, name: "favorites-bar", label: "Favorites" },
    ...FAVORITES.map(item), fill(), item({ title: "Other favorites", folder: true }));
}

/**
 * The standalone window, painted with one theme. `tabs`, `active`, `groups`
 * and `tabW` set the tab strip, `bar` the address bar, `side` a panel docked
 * on the right of the page, and `overlays` popovers placed over the whole
 * window.
 */
export function horizonWindow(theme, page, { tabs, active, groups, tabW, bar, side, overlays, pinned, activeButton, privateWindow, openFolder, label = "Start page" } = {}) {
  const outline = theme.outline ? "outline" : undefined;
  const content = stack({ grow: 1, clip: true, fill: "page", name: "start-page", label }, ...page);
  const body = side ? row({ grow: 1, align: "stretch" }, content, side) : content;
  const frame = col({ h: 900, fill: "page", theme: overlays ? undefined : theme, name: "window", label: "Horizon window" }, tabStrip({ tabs, active, groups, tabW, outline }), toolbar({ bar, outline, pinned, activeButton, privateWindow }), favoritesBar({ openFolder }), body);
  return overlays ? stack({ h: 900, theme }, frame, ...overlays) : frame;
}

/** The single right panel: Desktop and Lyra are its two faces. */
export function sidePanel(face, ...kids) {
  return col(
    { w: 400, h: PAGE_H, pad: 20, gap: 16, fill: "surface", edge: { side: "left", color: "line" }, name: "side-panel", label: `${face} panel` },
    row({ gap: 8 },
      seg(["Desktop", "Lyra"], face, { ref: "panel-face" }), fill(),
      btn("externalLink", { label: "Open in a tab", ref: "panel-open-tab" }),
      btn("x", { label: "Close panel", ref: "panel-close" })),
    hr(), ...kids,
  );
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
    { gap: 12, name: "home-lyra", label: "Ask Lyra" },
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
 * at the owner's choice); the ground below it is for research, with the Desktop project to
 * resume and Lyra. The sun sits on the line.
 */
export function startPage({ privateWindow = false } = {}) {
  const horizon = Math.round(PAGE_H * 420 / 804);
  const scaleY = (y) => Math.round(y * PAGE_H / 804);
  return stack(
    { w: 1440, h: PAGE_H, place: { x: 0, y: 0 } },
    box({ w: 1440, h: horizon, fill: "sky", place: { x: 0, y: 0 } }),
    box({ w: 1440, h: PAGE_H - horizon, fill: "ground", place: { x: 0, y: horizon } }),
    box({ w: 1440, h: 1, fill: "horizon", place: { x: 0, y: horizon } }),
    vector({ d: ARC, w: 64, h: 32, stroke: "sun", strokeWidth: 1.5, place: { x: 688, y: horizon - 32 } }),
    col(
      // The private notice adds a line; the stack rises by half of it so the shortcuts keep their room above the sun.
      { w: 700, gap: 24, align: "center", place: { x: 370, y: scaleY(150) - (privateWindow ? 22 : 0) } },
      text("Horizon", { face: "display", size: 30, weight: 600, color: "title", track: 0.04 }),
      search({ w: 700 }),
      privateWindow ? text("Nothing from this window is kept after it closes; blocking is at its strictest.", { size: "sm", color: "soft", align: "center" }) : null,
      row({ gap: 24, justify: "center" }, ...SITES.map((site) => text(site, { size: "sm", color: "soft", name: `shortcut-${slug(site)}`, label: site }))),
    ),
    privateWindow ? null : col(
      { w: 700, gap: 0, place: { x: 370, y: scaleY(470) } },
      row(
        { h: 36, gap: 12, name: "resume", label: "Continue with Trip to Patagonia" },
        icon("layoutDashboard", { size: 16, color: "primary" }),
        text("Trip to Patagonia", { size: "base", weight: 600, color: "title" }),
        fill(),
        text("9 items, yesterday", { size: "xs", color: "soft" }),
      ),
      ...NOTES.map((note) => noteRow(note)),
      space(22),
      lyra(),
    ),
  );
}

// ---- shared flow screens --------------------------------------------------

const note = (value) => text(value, { size: "xs", color: "soft" });

const SITE_TABS = [
  { title: "Home", own: true },
  { title: "Route 40: gravel sections and fuel stops", color: "site-routes", initial: "R" },
  { title: "Sourdough bread: the complete guide", color: "site-bread", initial: "S" },
];

// A site's own colours, light as published, and as Horizon's dark mode
// repaints it.
const ROUTES = {
  light: { bg: "page", card: "surface", ink: "title", soft: "soft", accent: "success", img: "surface-3" },
  dark: { bg: "page", card: "surface", ink: "title", soft: "soft", accent: "success", img: "surface-3" },
};

/** Rutas del Sur, a travel article. */
function routesSite({ dark = false, width = 1440, height = PAGE_H } = {}) {
  const p = dark ? ROUTES.dark : ROUTES.light;
  const side = Math.max(24, (width - 800) / 2);
  return col(
    { w: width, h: height, theme: dark ? AMBER : DAYLIGHT, fill: p.bg, place: { x: 0, y: 0 }, name: "site", label: "Site: Rutas del Sur" },
    row(
      { h: 64, pad: [0, side], gap: 28, fill: p.card },
      text("Rutas del Sur", { face: "serif", size: 22, weight: 700, color: p.ink }),
      fill(),
      ...(width < 800 ? ["Maps"] : ["Routes", "Weather", "Maps", "Subscribe"]).map((item) => text(item, { size: "sm", color: p.soft })),
    ),
    col(
      { pad: [40, side, 0, side], gap: 14 },
      text("Patagonia", { size: "xs", weight: 700, color: p.accent, upper: true, track: 0.08 }),
      text("Route 40: gravel sections and fuel stops", { face: "serif", size: width < 800 ? 28 : 38, color: p.ink, lh: 1.2 }),
      text("By Lucía Ferrer. 12 minute read.", { size: "sm", color: p.soft }),
      space(6),
      box({ h: width < 800 ? 180 : 230, radius: "lg", fill: p.img, name: "site-photo", label: "Article photo" }),
      space(6),
      text("Three gravel sections remain between El Calafate and Perito Moreno. The longest runs for about 70 kilometres and is best driven by day, on tyres in good shape.", { size: "base", color: p.ink }),
      text("There can be more than 200 kilometres between two fuel stations: fill up in every town, even when the tank is not empty.", { size: "base", color: p.ink }),
    ),
  );
}


const SITE_BAR = { value: "rutasdelsur.example/ruta-40", blocked: 23 };


const site = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Site" });


const capture = () => captureShot();

// A popover opens 6 px under the control that opens it, right-aligned to it.
const toolbarPopup = (ref, w) => {
  const at = locate(toolbar(), 1440, ref);
  return { x: Math.max(12, Math.min(1440 - w - 12, at.x + at.w - w)), y: 44 + at.y + at.h + 6 };
};
// The size a node takes when laid out alone, so it can be placed by its own size.
const sizeOf = (node) => locate(stack({ w: 1440, h: 900 }, { ...node, place: { x: 0, y: 0 } }), 1440, node.name, 900);


const FUNCTIONS = [
  ["layoutDashboard", "Desktop"], ["sparkles", "Lyra"], ["columns2", "Split view"],
  ["languages", "Translate"], ["palette", "Themes"], ["orbit", "Nebula"],
];
const HUB_W = 360;
const HUB_H = 640;
const hubCard = ([glyph, title], { ref, pressed = false } = {}) => col({ w: 72, gap: 8, align: "center", name: ref ?? `hub-${slug(title)}`, label: title },
  stack({ w: 72, h: 72, radius: "lg", fill: pressed ? "surface-3" : "surface", stroke: pressed ? "line-strong" : "line" }, icon(glyph, { size: 28, color: "primary", place: "center" })),
  text(title, { w: 72, size: "xs", color: "title", align: "center", lines: 1 }));
const hubDock = (home = true) => row({ w: 328, h: 58, pad: 8, gap: 8, radius: "lg", fill: "surface-2", name: "hub-dock", label: "Quick access" },
  btn("house", { size: 40, active: home, label: "Hub Home", ref: "hub-home", tone: home ? "primary" : "soft" }),
  ...PINNED.map(({ glyph, label: title, ref }) => btn(glyph, { size: 40, label: title, ref: `dock-${ref}` })));
// Every Hub page puts its title 16 px under the dock and its content 12 px under the title.
const hubPage = (title, ...kids) => col({ gap: 12 }, heading(title), ...kids);
function hubPopup({ pressed } = {}) {
  return popover({ shadow: false, w: HUB_W, h: HUB_H, pad: 0, gap: 0, radius: "xl", clip: true, fill: "sky", place: toolbarPopup("hub", HUB_W), name: "hub-popup", label: "Hub" },
    stack({ w: HUB_W, h: HUB_H },
    box({ w: HUB_W, h: 180, fill: "ground", place: { x: 0, y: 460 } }),
    box({ w: HUB_W, h: 1, fill: "horizon", place: { x: 0, y: 460 } }),
    vector({ d: ARC, w: 64, h: 32, stroke: "sun", place: { x: 148, y: 428 } }),
    col({ w: 328, gap: 16, place: { x: 16, y: 16 } },
      hubDock(), hubPage("Hub", col({ gap: 31 }, ...[0, 3].map((start) => row({ gap: 56 },
        ...FUNCTIONS.slice(start, start + 3).map((item) => hubCard(item, { pressed: item[1] === pressed }))))))),
    ),
  );
}
const hub = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, activeButton: "hub", overlays: [hubPopup()], label: "Site" });
// A tile's menu opens 6 px under its label, right-aligned to the tile, inside the Hub's own coordinates.
const tileMenuPlace = (popup, w) => {
  const card = locate(popup, HUB_W, "hub-split-view", HUB_H);
  return { x: card.x + card.w - w, y: card.y + card.h + 6 };
};
const pin = () => {
  const popup = hubPopup({ pressed: "Split view" });
  const at = tileMenuPlace(popup, 232);
  return horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, activeButton: "hub", label: "Site", overlays: [popup,
    popover({ radius: "lg", shadow: false, w: 232, place: { x: popup.place.x + at.x, y: popup.place.y + at.y }, name: "hub-card-menu", label: "Split view actions" },
      menuRow("Open", { glyph: "externalLink", ref: "open-split" }),
      menuRow("Add to quick access", { glyph: "pin", active: true, ref: "add-quick-access" })),
  ] });
};


function themePreview(theme, variant = -1, w = 204, h = 112) {
  const looks = [
    { sky: "surface-2", ground: "surface-3", sun: "info", chrome: "chrome" },
    { sky: "sky", ground: "wash", sun: "warning", chrome: "surface-2" },
    { sky: "chrome", ground: "surface-3", sun: "soft", chrome: "surface" },
    { sky: "ground", ground: "wash", sun: "success", chrome: "surface-2" },
  ];
  const p = looks[variant] ?? { sky: "sky", ground: "ground", sun: "sun", chrome: "chrome" };
  const preview = stack({ w: 204, h: 112, theme, fill: p.sky, radius: "md", clip: true, stroke: "line" },
    row({ w: 204, h: 18, fill: p.chrome, place: { x: 0, y: 0 }, pad: [0, 8], gap: 5 }, dot("primary", 5), box({ w: 52, h: 8, radius: "xs", fill: "surface-3" })),
    box({ w: 204, h: 14, fill: "surface-2", place: { x: 0, y: 18 } }),
    box({ w: 204, h: 36, fill: p.ground, place: { x: 0, y: 76 } }),
    box({ w: 204, h: 1, fill: "horizon", place: { x: 0, y: 76 } }),
    vector({ d: ARC, w: 32, h: 16, stroke: p.sun, place: { x: 86, y: 60 } }),
    box({ w: 104, h: 10, radius: "sm", fill: "field", stroke: "field-line", place: { x: 50, y: 44 } }),
  );
  return { ...preview, w, h, kids: preview.kids.map((kid) => ({ ...kid,
    w: typeof kid.w === "number" ? Math.round(kid.w * w / 204) : kid.w,
    h: typeof kid.h === "number" ? Math.round(kid.h * h / 112) : kid.h,
    place: typeof kid.place === "object" ? { x: Math.round(kid.place.x * w / 204), y: Math.round(kid.place.y * h / 112) } : kid.place,
  })) };
}

const smallTheme = (title, theme, { chosen = false, installed = false, variant = -1 } = {}) =>
  col({ w: 158, gap: 5, name: `theme-${slug(title)}`, label: title },
    // The outline is drawn over the preview, so a preview the colour of the panel keeps its edge.
    stack({ w: 158, h: 68, radius: "md", clip: true },
      themePreview(theme, variant, 158, 68),
      box({ w: 158, h: 68, radius: "md", stroke: chosen ? "primary" : "line", strokeWidth: chosen ? 2 : 1, place: { x: 0, y: 0 } })),
    row({ h: 26, gap: 4 }, text(title, { size: "xs", color: "title", grow: 1 }),
      installed ? (chosen ? icon("check", { size: 14, color: "primary" }) : null) : action("Get", { h: 24, ref: `get-${slug(title)}` })));

const themesPopup = () => popover({ shadow: false, w: HUB_W, h: HUB_H, pad: 16, gap: 16, radius: "xl", place: toolbarPopup("hub", HUB_W), name: "hub-themes-page", label: "Themes in Hub" },
  hubDock(false), hubPage("Themes",
    col({ gap: 8 }, label("Installed"),
      row({ gap: 12 }, smallTheme("Amber", AMBER, { installed: true, chosen: true }), smallTheme("Daylight", DAYLIGHT, { installed: true })),
      row({ gap: 12 }, smallTheme("High contrast", CONTRAST_DARK, { installed: true }))),
    col({ gap: 8 }, label("Marketplace"),
      ...[0, 2].map((start) => row({ gap: 12 }, ...["Fjord", "Dune", "Graphite", "Moss"].slice(start, start + 2).map((title, i) =>
        smallTheme(title, { Fjord: FJORD, Dune: DUNE, Graphite: GRAPHITE, Moss: MOSS }[title])))))));
const themes = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, activeButton: "hub", overlays: [themesPopup()], label: "Site" });


const PROJECT_META = "4 pages, 3 captures, 2 notes";
const captureImage = (w, h) => stack({ w, h, radius: "md", clip: true, fill: "surface-3", name: "capture-image", label: "Captured gravel section" },
  box({ w, h: Math.round(h * 0.58), fill: "sky", place: { x: 0, y: 0 } }),
  vector({ d: "M0 100 L20 45 L35 68 L63 20 L100 100 Z", w, h: Math.round(h * 0.65), fill: "soft", opacity: 0.3, place: { x: 0, y: Math.round(h * 0.18) } }),
  vector({ d: "M30 100 L47 55 L53 55 L76 100 Z", w, h, fill: "dim", opacity: 0.5, place: { x: 0, y: 0 } }));
// Every leading mark gets the same 24 px slot, so the titles share one column.
const desktopItem = (title, subtitle, lead, { selected = false, ref } = {}) => row({ name: ref, label: title, h: 70, pad: [8, 10], gap: 10, radius: "md", fill: selected ? "wash" : undefined },
  stack({ w: 24, h: 24 }, { ...lead, place: "center" }), col({ grow: 1, gap: 3 }, text(title, { size: "sm", weight: 600, color: "title", lines: 1 }), note(subtitle)));

const desktopPanel = ({ detailed = false } = {}) => {
  const root = horizonWindow(AMBER, [routesSite({ width: 1040 })], {
  tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Site with Desktop",
  side: sidePanel("Desktop",
    col({ gap: 6 }, dropdown("Trip to Patagonia", { lead: icon("layoutDashboard", { size: 16, color: "primary" }), ref: "desktop-project" }),
      note(PROJECT_META)), row({ gap: 8 }, action("Route 40", { glyph: "folder", ref: "folder-route-40" }), action("Lodging", { glyph: "folder", ref: "folder-lodging" })),
    col({ gap: 4 },
      desktopItem("Capture: gravel sections", "Saved just now", icon("scan", { size: 22, color: "primary" }), { selected: true }),
      desktopItem("Lago Azul Inn: your booking", "lagoazul.example", badge("site-inn", { initial: "L", size: 24, radius: "sm", ink: "site-ink" }), { ref: "item-inn" }),
      desktopItem("Budget: accommodation and car", "Allow two nights beside the lake.", icon("fileText", { size: 22, color: "soft" })),
      desktopItem("Summary of 2 pages", "Lyra · Rutas del Sur, Lago Azul Inn", icon("sparkles", { size: 22, color: "primary" }))),
    fill(),
    col({ h: 88, pad: 12, gap: 8, radius: "lg", stroke: "primary", dash: "5 4", fill: "wash", justify: "center", align: "center", name: "desktop-drop", label: "Drag into Desktop" },
      row({ gap: 8 }, icon("link", { size: 18, color: "primary" }), text("Drag a link, a tab, a text or an image here", { size: "sm", color: "primary" }))),
    (detailed ? row({ gap: 8 }, action("New note", { glyph: "plus", ref: "desktop-new-note" }), action("New folder", { glyph: "folderPlus", ref: "desktop-new-folder" })) : action("New note", { glyph: "plus", ref: "desktop-new-note" }))),
});
  const target = locate(root, 1440, "desktop-drop", 900);
  const endX = target.x, endY = target.y + target.h / 2;
  return stack({ h: 900, theme: AMBER }, root,
    vector({ d: "M0 0 C38 0 54 100 100 100 M97 96 L100 100 L96 100", w: endX - 820, h: endY - 380, stroke: "primary", strokeWidth: 2, dash: "6 4", place: { x: 820, y: 380 }, name: "drag-link-path", label: "Link dragged from the page into Desktop" }),
    row({ h: 40, pad: [0, 10], gap: 8, radius: "md", fill: "wash", stroke: "primary", place: { x: 790, y: endY - 66 }, name: "dragged-link", label: "Dragged page link" },
      icon("link", { size: 16, color: "primary" }), text("Route 40: gravel sections", { size: "xs", color: "on-wash" }), icon("mousePointer2", { size: 16, color: "primary" })));
};


export { SITE_TABS, SITE_BAR, routesSite, site, capture, toolbarPopup, sizeOf, HUB_W, HUB_H, hubPopup, tileMenuPlace, hub, pin, themePreview, themesPopup, themes, PROJECT_META, captureImage, desktopPanel };

// Shared drawings used by the overview and the area boards.
// Only the question sits in a bubble; Lyra answers in plain text at the column's full width.
const bubble = (value) =>
  row({ justify: "end" }, box({ pad: [10, 14], radius: "lg", fill: "wash" }, text(value, { size: "sm", color: "on-wash" })));
const answer = (value) => text(value, { size: "sm", color: "text" });


const lyraPermission = () => panelWindow("Lyra", titleBlock("Summary", lyraStatus()),
  bubble("Summarise this page"),
  col(
    { pad: 16, gap: 10, radius: "lg", fill: "surface-2", stroke: "line", name: "lyra-permission", label: "Permission to read" },
    text("Can I read this page?", { size: "base", weight: 650, color: "title" }),
    text("To summarise it I need to read rutasdelsur.example.\nI run on your computer: nothing leaves it.", { size: "sm", color: "text" }),
    space(4),
    col({ gap: 8 }, action("Allow on this site", { primary: true, ref: "allow-site" }),
      row({ gap: 8 }, action("Just this once", { grow: 1, ref: "allow-once" }), action("No", { grow: 1, ref: "deny" }))),
  ));

const lyraSummary = () => panelWindow("Lyra", titleBlock("Summary", lyraStatus()),
  bubble("Summarise this page"),
  answer("Three gravel sections remain; the longest is about 70 km and best driven by day. Stations can be more than 200 km apart, so fill up in every town."),
  row({ gap: 8 }, saveLyra(), action("Compare", { glyph: "columns2", ref: "compare" })),
  fill(), askField());


const pageHeader = (initial, host, focused, { menu = false } = {}) => row({ h: 34, pad: [0, 10], gap: 8, fill: focused ? "wash" : "surface", edge: { side: "bottom", color: "line" }, name: `pane-${slug(host)}` },
  badge(initial === "R" ? "site-routes" : "site-inn", { initial, size: 16, radius: "xs", ink: "site-ink" }), text(host, { size: "xs", color: "title" }), fill(),
  menu ? btn("ellipsis", { label: "Page options", ref: "split-menu-button", g: 14 }) : null, btn("x", { label: `Close ${host}`, g: 14 }));
const splitDivider = () => stack({ w: 16, fill: "surface-2", stroke: "line", name: "split-divider", label: "Resize split view" }, icon("gripVertical", { size: 14, color: "soft", place: "center" }));
const innPage = (width = 712, height = PAGE_H - 34) => col({ w: width, h: height, theme: DAYLIGHT, fill: "page", pad: [48, 40], gap: 18 },
  text("Lago Azul Inn", { size: 30, face: "serif", color: "title" }), note("A quiet stay beside the lake"),
  box({ h: 230, radius: "lg", fill: "surface-3" }), text("Your base for Patagonia", { size: "xl", color: "title" }),
  text("Warm rooms, breakfast by the water and trails close by. Find a room for your April trip.", { size: "base", color: "text" }), action("See rooms", { primary: true, ref: "see-rooms" }));
const split = ({ options = false } = {}) => horizonWindow(AMBER, [row({ w: 1440, h: PAGE_H, align: "stretch", place: { x: 0, y: 0 } },
  col({ w: 712, clip: true }, pageHeader("R", "rutasdelsur.example", true), stack({ h: PAGE_H - 34, clip: true }, routesSite({ width: 712, height: PAGE_H - 34 }))),
  splitDivider(),
  col({ w: 712, clip: true }, pageHeader("L", "lagoazul.example", false, { menu: options }), innPage()),
)], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, pinned: [...PINNED, { glyph: "columns2", label: "Split view", ref: "split-view" }], label: "Split view" });

const translate = ({ options = false } = {}) => horizonWindow(AMBER, [col({ w: 1440, h: PAGE_H, place: { x: 0, y: 0 } },
  row({ h: 42, pad: [0, 20], gap: 10, fill: "surface", edge: { side: "bottom", color: "line" }, name: "translation-bar", label: "Translation" },
    icon("languages", { size: 18, color: "primary" }), text("Translated from French", { size: "sm", color: "title" }), fill(), action("Show original", { ref: "show-original" }), options ? btn("ellipsis", { label: "Translate options", ref: "translate-menu-button" }) : null, btn("x", { label: "Close translation" })),
  col({ h: PAGE_H - 42, theme: DAYLIGHT, fill: "page", pad: [48, 320], gap: 18 },
    text("Lakes of the South", { size: 24, face: "serif", weight: 700, color: "title" }), note("Travel journal"),
    text("Three quiet walks around the lake", { size: 36, face: "serif", color: "title" }),
    box({ h: 230, radius: "lg", fill: "surface-3" }),
    text("Follow the shore at sunrise, take the woodland path after breakfast, and leave the ridge walk for a clear afternoon.", { size: "base", color: "text" })),
)], { tabs: [{ title: "Lakes of the South", color: "site-inn", initial: "L" }], bar: { value: "lacsdusud.example/walks", blocked: 8 }, label: "Translated site" });


const projectCard = (title, subtitle, preview, { glyph, initial, color, body, sources } = {}) => col({ w: 350, pad: 14, gap: 8, radius: "lg", fill: "surface", stroke: "line", name: `desktop-card-${slug(title)}`, label: title },
  preview ?? row({ h: 38, gap: 8 }, icon(glyph ?? "fileText", { size: 22, color: "primary" }), note(glyph === "sparkles" ? "Lyra summary" : "Note")),
  row({ gap: 8 }, initial ? badge(color, { initial, size: 20, radius: "xs", ink: "site-ink" }) : null,
    text(title, { size: "sm", weight: 600, color: "title", lines: 2, grow: 1 })),
  note(subtitle), body ? text(body, { size: "sm", color: "text", lines: 3 }) : null,
  sources ? text(sources, { size: "xs", color: "soft", lines: 2 }) : null);
const pagePreview = (title, color) => col({ h: 106, pad: 12, gap: 8, radius: "md", fill: "surface-2" },
  text(title, { size: "xs", weight: 650, color }), box({ h: 36, radius: "sm", fill: "surface-3" }),
  box({ w: 170, h: 4, radius: "xs", fill: "line-strong", self: "start" }));
const desktop = ({ share = false } = {}) => horizonWindow(AMBER, [row({ w: 1440, h: PAGE_H, align: "stretch", place: { x: 0, y: 0 } },
  col({ w: 280, pad: 20, gap: 8, fill: "surface", edge: { side: "right", color: "line" }, name: "desktop-rail", label: "Desktop projects" },
    row({ gap: 10, h: 44 }, icon("layoutDashboard", { size: 24, color: "primary" }), text("Desktop", { size: "lg", weight: 650, color: "title" })),
    label("Projects"), menuRow("Trip to Patagonia", { glyph: "folder", active: true, ref: "project-patagonia", h: 44 }),
    menuRow("Sourdough experiments", { glyph: "folder", ref: "project-sourdough", h: 44 }), fill(),
    action("New project", { glyph: "plus", ref: "new-project" })),
  col({ w: 1160, pad: [28, 36], gap: 18 },
    row({ gap: 10 }, text("Trip to Patagonia", { size: "2xl", weight: 650, color: "title" }), fill(), note(PROJECT_META)),
    row({ gap: 8 }, action("Ask Lyra about this project", { glyph: "sparkles", ref: "ask-project" }),
      action("Open as tab group", { glyph: "group", ref: "project-tab-group" }), share ? action("Share", { glyph: "share2", ref: "project-share" }) : null, action("New note", { glyph: "plus", ref: "new-note" })),
    row({ gap: 8 }, action("All", { primary: true, ref: "filter-all" }), action("Route 40", { glyph: "folder", ref: "filter-route-40" }), action("Lodging", { glyph: "folder", ref: "filter-lodging" })),
    row({ gap: 19, align: "stretch" },
      projectCard("Route 40: gravel sections and fuel stops", "rutasdelsur.example", pagePreview("Rutas del Sur", "site-routes"), { initial: "R", color: "site-routes" }),
      projectCard("Lago Azul Inn: your booking", "lagoazul.example", pagePreview("Lago Azul Inn", "site-inn"), { initial: "L", color: "site-inn" }),
      projectCard("Capture: gravel sections", "From rutasdelsur.example · today", captureImage(322, 106))),
    row({ gap: 19, align: "stretch" },
      projectCard("Budget: accommodation and car", "Updated yesterday", null, { body: "Allow two nights beside the lake. Keep a reserve for fuel and gravel-road delays." }),
      projectCard("El Chaltén in April", "Capture · yesterday", captureImage(322, 106)),
      projectCard("Summary of 2 pages", "Saved by Ana · today", null, { glyph: "sparkles", body: "Drive the long section by day. Stay by the lake before heading north.", sources: "Sources: rutasdelsur.example/ruta-40\nlagoazul.example/booking" }))),
)], { tabs: [{ title: "Desktop: Trip to Patagonia", own: true }, SITE_TABS[1]], bar: { value: "horizon://desktop/trip-to-patagonia", blocked: null }, label: "Desktop in a tab" });


export { bubble, lyraPermission, lyraSummary, innPage, split, translate, desktop, pagePreview, projectCard };

// Fjord uses the same roles as Amber. Cool surfaces, readable type and frames.
export const FJORD = {
  ...AMBER, canvas: "#10191d", surface: "#1b2a30", "surface-2": "#24353c", "surface-3": "#2d424a",
  glass: "rgba(27,42,48,0.9)", hover: "#24353c", "border-subtle": "#728e98",
  line: "#819da7", "line-strong": "#819da7", frame: "#91adb7",
  title: "#eef5f6", text: "#dce9ed", soft: "#bed1d8", dim: "#b4cad2",
  primary: "#a4d1da", "primary-hover": "#badfe6", "on-primary": "#10282f",
  wash: "#233a43", "on-wash": "#d9eff4", "primary-border": "#91adb7",
  error: "#f2b9b7", "error-wash": "#3b262b", success: "#b7dbca", warning: "#e1d2a9", info: "#bfd5ec",
  overlay: "rgba(8,20,25,0.65)", shadow: "#10191d", "cover-from": "#2d424a", "cover-to": "#142127",
  white: "#eef5f6", chrome: "#142127", page: "#18252b", sky: "#18252b", ground: "#142127",
  horizon: "#a4d1da", sun: "#a4d1da", field: "#24353c", "field-line": "#819da7",
};

// Graphite uses Amber's roles on near-neutral greys with a calm periwinkle accent.
export const GRAPHITE = {
  ...AMBER,
  canvas: "#0e0f11", surface: "#1b1c1f", "surface-2": "#222327", "surface-3": "#2b2d31",
  glass: "rgba(20, 21, 24, 0.9)", hover: "#1d1e22",
  "border-subtle": "#26272b", line: "#313338", "line-strong": "#484a50", frame: "#7f828a",
  title: "#e8e9ec", text: "#cfd1d6", soft: "#a3a6ad", dim: "#989ba3",
  primary: "#aab6e0", "primary-hover": "#bdc7e8", "on-primary": "#141826",
  wash: "#22263a", "on-wash": "#c9d2f0", "primary-border": "rgba(170, 182, 224, 0.4)",
  error: "#e5958f", "error-wash": "#2b1b1c", success: "#93c6a4", warning: "#d6bb7a", info: "#9fc0d8",
  purple: "#bfa8d6", cyan: "#8fc3c4",
  overlay: "rgba(0, 0, 0, 0.6)", shadow: "#000000", "cover-from": "#484a50", "cover-to": "#131416", white: "#e8e9ec",
  chrome: "#131416", page: "#18191b", sky: "#18191b", ground: "#121315", horizon: "#aab6e0", sun: "#aab6e0",
  field: "#202125", "field-line": "#34363b",
};

// Dune is a light theme made by hand like Daylight: a dim sand floor, a raised layer one step lighter,
// shadows in the floor's hue, and a deep clay accent kept to small marks.
export const DUNE = {
  ...DAYLIGHT,
  canvas: "#efe8dd", surface: "#f6f1ea", "surface-2": "#e5ddd0", "surface-3": "#ded5c7",
  glass: "rgba(236, 228, 216, 0.9)", hover: "#e8e0d4",
  "border-subtle": "#e0d8cb", line: "#d9d0c2", "line-strong": "#c5baa9", frame: "#80766a",
  title: "#3d3328", text: "#4a4035", soft: "#5d5246", dim: "#62574b",
  primary: "#7a4527", "primary-hover": "#6b3c21", "on-primary": "#f6f1ea",
  wash: "#eadccd", "on-wash": "#6b3c21", "primary-border": "rgba(122, 69, 39, 0.3)",
  error: "#8a3833", "error-wash": "#f1e0d9", success: "#3c5d3a", warning: "#6d4c1f", info: "#3f527a",
  purple: "#674a7a", cyan: "#2f5f63",
  overlay: "rgba(61, 51, 40, 0.24)", shadow: "#d2c6b5", "cover-from": "#e5ddd0", "cover-to": "#f6f1ea", white: "#f6f1ea",
  chrome: "#e9e1d5", page: "#efe8dd", sky: "#efe8dd", ground: "#ebe3d7", horizon: "#a99d8b", sun: "#7a4527",
  field: "#f6f1ea", "field-line": "#d9d0c2",
};

// Moss is a light theme on a sage-grey floor with a deep moss accent, made by the same recipe as Dune.
export const MOSS = {
  ...DAYLIGHT,
  canvas: "#eaede6", surface: "#f2f4ef", "surface-2": "#dfe3da", "surface-3": "#d9ddd3",
  glass: "rgba(229, 233, 224, 0.9)", hover: "#e2e6dd",
  "border-subtle": "#dbdfd5", line: "#d3d8cd", "line-strong": "#bdc3b5", frame: "#737a6d",
  title: "#2f382b", text: "#3c4637", soft: "#4f5949", dim: "#545e4e",
  primary: "#3f5b2e", "primary-hover": "#354f26", "on-primary": "#f2f4ef",
  wash: "#dce5d3", "on-wash": "#354f26", "primary-border": "rgba(63, 91, 46, 0.3)",
  error: "#8a3a36", "error-wash": "#efe1de", success: "#2f5d47", warning: "#6a4d1f", info: "#3c5180",
  purple: "#654a78", cyan: "#2d5e60",
  overlay: "rgba(47, 56, 43, 0.24)", shadow: "#c7cdbf", "cover-from": "#dfe3da", "cover-to": "#f2f4ef", white: "#f2f4ef",
  chrome: "#e3e7de", page: "#eaede6", sky: "#eaede6", ground: "#e6e9e2", horizon: "#9aa290", sun: "#3f5b2e",
  field: "#f2f4ef", "field-line": "#d3d8cd",
};

export function scaled(node, factor, prefix) {
  const out = { ...node };
  for (const key of Object.keys(out)) if (key.startsWith("_")) delete out[key];
  for (const key of ["w", "h", "minH", "gap", "dx", "dy", "strokeWidth"])
    if (typeof out[key] === "number") out[key] *= factor;
  if (typeof out.size === "number") out.size *= factor;
  else if (out.t === "text") out.size = SIZES[out.size ?? "sm"] * factor;
  if (Array.isArray(out.pad)) out.pad = out.pad.map(n => n * factor);
  else if (typeof out.pad === "number") out.pad *= factor;
  if (typeof out.place === "object") out.place = { x: out.place.x * factor, y: out.place.y * factor };
  if (out.name) out.name = `${prefix}-${out.name}`;
  if (out.kids) out.kids = out.kids.map(kid => scaled(kid, factor, prefix));
  return out;
}

export const siteWindow = (overlays = [], theme = AMBER) => horizonWindow(theme, [routesSite()], {
  tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Site", overlays,
});
export const panelWindow = (face, ...kids) => horizonWindow(AMBER, [routesSite({ width: 1040 })], {
  tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: `Site with ${face}`, side: sidePanel(face, ...kids),
});
export const heading = value => text(value, { size: "lg", weight: 650, color: "title" });
// A page title keeps its status lines 4 px under it, closer than the content that follows.
const titleBlock = (title, ...lines) => col({ gap: 4 }, heading(title), ...lines);

// List-opening controls keep a separate chevron column at the right edge.
export function dropdown(value, options = {}) {
  const control = select(value, options);
  control.kids.splice(-1, 0, vr(18));
  return { ...control, gap: 10 };
}

// Quiet actions in a content column share its left edge and available width.
const quietAction = (value, options = {}) => ({
  ...action(value, { ...options, ghost: true }), justify: "start", pad: 0,
});

export const screenshotPreview = (w = 328, prefix = "preview") => stack({ w, h: PAGE_H * w / 1440, radius: "md", clip: true, name: `${prefix}-image`, label: "Visible page screenshot" },
  { ...scaled(routesSite(), w / 1440, prefix), place: { x: 0, y: 0 } });

export const projectSaveButton = () => row({ h: 32, radius: "md", clip: true, fill: "primary", name: "capture-save", label: "Save to Trip to Patagonia" },
  { ...action("Save to Trip to Patagonia", { primary: true, grow: 1, ref: "capture-save-project" }), justify: "start" },
  vr(20, { fill: "on-primary", opacity: 0.3 }),
  btn("chevronDown", { label: "Choose project", ref: "capture-projects", tone: "on-primary" }));

export const projectSelector = (place, w = 328) => popover({ w, pad: 14, gap: 8, radius: "lg", shadow: false, place, name: "project-selector", label: "Save to" },
  heading("Save to"), { ...input("Search projects"), gap: 10, name: "search-projects", label: "Search projects" },
  menuRow("Trip to Patagonia", { lead: icon("check", { size: 16, color: "primary" }), active: true, ref: "save-project-trip", h: 40 }),
  menuRow("Sourdough experiments", { glyph: "folder", ref: "save-project-sourdough", h: 40 }),
  hr(), menuRow("New project", { glyph: "plus", ref: "save-new-project", h: 40 }));

export const capturePreviewCard = () => popover({ w: 356, pad: 14, gap: 12, radius: "lg", shadow: false, place: toolbarPopup("capture", 356), name: "capture-preview", label: "Screenshot preview" },
  screenshotPreview(),
  row({ gap: 4, justify: "between" }, ...[["Crop", "crop", "capture-crop"], ["Full page", "appWindow", "capture-full"], ["Copy", "copy", "capture-copy"], ["Lyra", "sparkles", "capture-lyra"]].map(([title, glyph, ref]) =>
    col({ w: 78, gap: 2, align: "center", name: ref, label: title }, btn(glyph, { size: 28, label: title, ref: `${ref}-button`, tone: "primary" }), text(title, { size: "xs", color: "title" })))),
  note("Kept in Captures"), hr(), projectSaveButton());

export function captureShot({ selector = false } = {}) {
  const card = capturePreviewCard();
  const at = locate(card, 356, "capture-save", 410);
  // At the card's width and under it, so the card and the selector read as one stack.
  return siteWindow([card, selector ? projectSelector({ x: card.place.x, y: card.place.y + at.y + at.h + 14 + 8 }, 356) : null]);
}
export const captureSite = () => {
  const tip = popover({ pad: [6, 10], radius: "md", shadow: false, name: "capture-tooltip", label: "Capture shortcut" }, note("Capture (Ctrl+Shift+S)"));
  return siteWindow([{ ...tip, place: toolbarPopup("capture", sizeOf(tip).w) }]);
};

export function captureEditor({ full = false, selector = false } = {}) {
  const crop = { x: 310, y: 239, w: 820, h: 329 };
  const image = full ? stack({ w: 1440, h: PAGE_H, fill: "canvas", place: { x: 0, y: PAGE_TOP } },
    { ...scaled(fullPageScreenshot(), 0.29, "full"), place: { x: 511, y: 100 } }) : stack({ w: 1440, h: PAGE_H, clip: true, place: { x: 0, y: PAGE_TOP } },
    routesSite(),
    box({ w: 1440, h: crop.y, fill: "overlay", place: { x: 0, y: 0 } }),
    box({ w: crop.x, h: crop.h, fill: "overlay", place: { x: 0, y: crop.y } }),
    box({ w: 1440 - crop.x - crop.w, h: crop.h, fill: "overlay", place: { x: crop.x + crop.w, y: crop.y } }),
    box({ w: 1440, h: PAGE_H - crop.y - crop.h, fill: "overlay", place: { x: 0, y: crop.y + crop.h } }),
    box({ w: crop.w, h: crop.h, radius: "sm", stroke: "primary", strokeWidth: 2, place: { x: crop.x, y: crop.y }, name: "crop-rectangle", label: "Crop rectangle" }),
    ...[[0, 0], [crop.w, 0], [0, crop.h], [crop.w, crop.h]].map(([x, y], i) => box({ w: 12, h: 12, radius: "xs", fill: "primary", place: { x: crop.x + x - 6, y: crop.y + y - 6 }, name: `crop-handle-${i}` })));
  const bar = row({ w: 1100, h: 48, pad: [0, 8], gap: 12, radius: "lg", fill: "surface", stroke: "frame", place: { x: 170, y: PAGE_TOP + 20 }, name: "capture-editor-bar", label: "Screenshot editor" },
    seg(["Screen", "Full page"], full ? "Full page" : "Screen", { ref: "editor-kind" }), fill(), action("Cancel", { ghost: true, ref: "editor-cancel" }), projectSaveButton());
  return siteWindow([image, bar, selector ? projectSelector({ x: 942, y: PAGE_TOP + 76 }) : null]);
}
function fullPageScreenshot() {
  return col({ w: 1440, h: 2200, theme: DAYLIGHT, fill: "page", radius: "lg", clip: true },
    { ...routesSite(), place: undefined },
    col({ pad: [40, 320], gap: 26 }, heading("Fuel stops along Route 40"), text("El Calafate · Tres Lagos · Gobernador Gregores · Perito Moreno", { color: "text" }),
      box({ h: 340, radius: "lg", fill: "surface-3" }), heading("The map and the gravel sections"),
      text("Plan each day's drive around daylight and fuel. Leave time for the slower gravel sections.", { size: "base", color: "text" }),
      box({ h: 330, radius: "lg", fill: "surface-3" }), heading("Before you leave"), text("Check the weather, carry water and fill up in town.", { color: "text" })),
    fill(), row({ h: 80, pad: [0, 320], fill: "surface" }, note("Rutas del Sur · Routes · Weather · Maps")));
}
// The action keeps its own padding inside the toast's, so its label sits as far from the right edge as the message from the left.
export const captureSaved = () => siteWindow([popover({ w: 400, pad: [8, 8, 8, 16], radius: "lg", shadow: false, place: { x: 520, y: 816 }, name: "saved-status", label: "Saved" },
  row({ gap: 12 }, text("Saved to Trip to Patagonia", { size: "sm", color: "title" }), fill(), { ...action("Open", { ghost: true, ref: "saved-open" }), pad: [0, 8] }))]);

export const shareDialog = () => popover({ w: 560, pad: 24, gap: 18, radius: "xl", shadow: false, name: "share-dialog", label: "Share with a Space" },
  heading("Share Trip to Patagonia with Lago Azul Studio?"),
  text("The project leaves this computer for Lago Azul Studio's members, and what they do with it is theirs.", { size: "sm", color: "text" }),
  row({ gap: 10, justify: "end" }, { ...action("Cancel", { ref: "share-cancel" }), stroke: "primary", strokeWidth: 2, label: "Cancel, focused" }, action("Share", { primary: true, ref: "share-confirm" })));
// Every dialog sits at the centre of the window, whatever its height.
export const withDialog = (root, dialog) => {
  const at = sizeOf(dialog);
  return stack({ w: 1440, h: 900, theme: AMBER }, root, box({ w: 1440, h: 900, fill: "overlay" }),
    { ...dialog, place: { x: Math.round((1440 - at.w) / 2), y: Math.round((900 - at.h) / 2) } });
};

export const nebulaPopup = () => popover({ w: HUB_W, h: HUB_H, pad: 16, gap: 16, radius: "xl", shadow: false, place: toolbarPopup("hub", HUB_W), name: "nebula-popup", label: "Nebula" },
  hubDock(false), hubPage("Nebula",
    row({ gap: 10 }, badge("primary", { initial: "AF", size: 36, ink: "on-primary" }), col({ gap: 2 }, text("Ana Ferrer", { size: "base", weight: 650, color: "title" }), note("Nebula+"))), hr(),
    col({ gap: 4 }, label("Spaces"), menuRow("Personal space", { glyph: "lock", ref: "space-personal" }),
      col({ gap: 2 }, menuRow("Lago Azul Studio", { glyph: "users", ref: "space-studio" }),
        row({ gap: 6, pad: [0, 10] }, ...["AF", "ML", "JR"].map(initial => badge("surface-3", { initial, size: 26, ink: "title" }))))), hr(),
    col({ gap: 4 }, label("Shared with you"),
      row({ h: 52, pad: [0, 10], gap: 10, radius: "sm", name: "shared-project", label: "Lake photo locations" }, icon("folder", { size: 16, color: "soft" }),
        col({ gap: 2 }, text("Lake photo locations", { size: "sm", color: "title" }), note("Shared by Mateo Luna · Lago Azul Studio"))))),
  fill(), action("Share a project", { glyph: "share2", ref: "nebula-share" }));
export const nebula = () => siteWindow([nebulaPopup()]);

const pickRow = (title, color, initial, ref) => menuRow(title, { lead: badge(color, { initial, size: 22, ink: "site-ink", radius: "sm" }), ref, h: 44 });
export const splitPick = () => horizonWindow(AMBER, [row({ w: 1440, h: PAGE_H, align: "stretch", place: { x: 0, y: 0 } },
  col({ w: 712, clip: true }, pageHeader("R", "rutasdelsur.example", true), stack({ h: PAGE_H - 34, clip: true }, routesSite({ width: 712, height: PAGE_H - 34 }))),
  splitDivider(),
  col({ w: 712, pad: [48, 40], gap: 24, fill: "page" }, heading("Open on the right"), input("Search or enter an address"),
    col({ gap: 8 }, label("Open tabs"), pickRow("Lago Azul Inn", "site-inn", "L", "pick-inn"), pickRow("Sourdough bread: the complete guide", "site-bread", "S")),
    col({ gap: 8 }, label("Recent sites"), pickRow("Full map of Route 40", "site-map", "M"), pickRow("El Chaltén: trails open in April", "site-trails", "E"))),
)], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Choose right page" });

export function splitOptions() {
  const root = split({ options: true });
  const at = locate(root, 1440, "split-menu-button", 900), header = locate(root, 1440, "pane-lagoazul-example", 900);
  return stack({ w: 1440, h: 900, theme: AMBER }, root, popover({ w: 240, radius: "lg", shadow: false, place: { x: at.x + at.w - 240, y: header.y + header.h + 6 }, name: "split-options", label: "Split view options" },
    menuRow("Swap sides", { glyph: "arrowLeftRight", ref: "swap-sides" }), menuRow("Open in its own tab", { glyph: "externalLink", ref: "split-own-tab" }), menuRow("Close this side", { glyph: "x", ref: "split-close-side" })));
}
export function translateOptions() {
  const root = translate({ options: true });
  const at = locate(root, 1440, "translate-menu-button", 900), bar = locate(root, 1440, "translation-bar", 900);
  return stack({ w: 1440, h: 900, theme: AMBER }, root, popover({ w: 300, pad: 6, gap: 2, radius: "lg", shadow: false, place: { x: at.x + at.w - 300, y: bar.y + bar.h + 6 }, name: "translate-options", label: "Translate options" },
    col({ pad: [4, 0, 8, 0], gap: 6 }, label("Translate to"), dropdown("English", { ref: "translate-language" })),
    row({ h: 34, pad: [0, 10], gap: 10 }, text("Always translate French", { size: "sm", color: "title", grow: 1 }), switcher(false, { ref: "always-french", label: "Always translate French" })),
    menuRow("Never translate this site", { ref: "never-translate" }), menuRow("Show original", { ref: "menu-show-original" })));
}
export const originalPage = () => horizonWindow(AMBER, [col({ w: 1440, h: PAGE_H, place: { x: 0, y: 0 } },
  row({ h: 42, pad: [0, 20], gap: 10, fill: "surface", edge: { side: "bottom", color: "line" } }, icon("languages", { size: 18, color: "primary" }), text("Original · French", { color: "title" }), fill(), action("Translate to English", { ref: "translate-english" })),
  col({ h: PAGE_H - 42, theme: DAYLIGHT, fill: "page", pad: [48, 320], gap: 18 }, text("Lacs du Sud", { size: 24, face: "serif", weight: 700, color: "title" }), note("Carnet de voyage"),
    text("Trois promenades tranquilles autour du lac", { size: 36, face: "serif", color: "title" }), box({ h: 230, radius: "lg", fill: "surface-3" }),
    text("Suivez la rive au lever du soleil, prenez le sentier forestier apres le petit-dejeuner et gardez la crete pour un apres-midi clair.", { size: "base", color: "text" }))),
], { tabs: [{ title: "Lacs du Sud", color: "site-inn", initial: "L" }], bar: { value: "lacsdusud.example/walks", blocked: 8 }, label: "Original page" });

// Text actions beside a label or under a caption take the small size, so a header keeps one scale.
const smallLink = (value, ref) => ({ ...action(value, { ghost: true, h: 20, ref }), pad: 0, kids: [text(value, { size: "xs", weight: 600, color: "title" })] });

export const desktopHome = () => panelWindow("Desktop", heading("Desktop"),
  col({ gap: 12 }, row({ gap: 8 }, label("Captures"), fill(), smallLink("See all", "captures-see-all")),
    row({ gap: 12 }, ...[0, 1, 2].map(i => screenshotPreview(112, `latest-${i}`)))),
  panelList(label("Projects"), menuRow("Trip to Patagonia", { glyph: "folder", hint: "9 items", ref: "home-trip", h: 36 }),
    menuRow("Sourdough experiments", { glyph: "folder", hint: "6 items", ref: "home-sourdough", h: 36 })),
  fill(), action("New project", { glyph: "plus", ref: "home-new-project" }));

export const desktopNewProject = () => panelWindow("Desktop", heading("New project"),
  col({ gap: 8 }, label("Project name"), { ...input("Project name", { glyph: null, value: "Weekend in Bariloche", focus: true }), name: "project-name", label: "Project name" }),
  action("Create", { primary: true, ref: "create-project" }));
export const desktopEmpty = () => panelWindow("Desktop", titleBlock("Weekend in Bariloche", note("0 items")),
  text("Drag a link, a tab, a text or an image here, or capture with Ctrl+Shift+S.", { size: "sm", color: "text" }), action("New note", { glyph: "plus", ref: "empty-new-note" }));

export const desktopCaptures = () => panelWindow("Desktop", titleBlock("Captures", note("Kept on this computer")),
  ...[0, 2, 4].map(start => row({ gap: 12 }, ...[start, start + 1].map(i => col({ w: 174, gap: 8 },
    screenshotPreview(174, `kept-${i}`),
    col({ gap: 2 }, text(["Route 40", "Lake map", "Gravel section", "Lago Azul Inn", "Open trails", "Fuel stops"][i], { size: "sm", color: "title" }),
      { ...smallLink("Add to a project", `capture-add-${i}`), justify: "start" }))))));

export const desktopDrag = () => siteWindow([
  col({ w: 248, h: PAGE_H, pad: 20, gap: 16, fill: "surface", stroke: "primary", place: { x: 1192, y: PAGE_TOP }, name: "edge-drop", label: "Drop into Trip to Patagonia" },
    icon("folderInput", { size: 28, color: "primary" }), col({ gap: 4 }, note("Drop into"), heading("Trip to Patagonia")), note("Release to keep this link")),
  vector({ d: "M0 50 C35 50 60 50 100 50 M94 42 L100 50 L94 58", w: 340, h: 80, stroke: "primary", strokeWidth: 2, dash: "6 4", place: { x: 850, y: 465 }, name: "drag-to-edge", label: "Drag to the right edge" }),
  row({ h: 40, pad: [0, 10], gap: 8, radius: "md", fill: "wash", stroke: "primary", place: { x: 930, y: 530 }, name: "dragged-link", label: "Dragged page link" },
    badge("site-routes", { initial: "R", size: 20, radius: "xs", ink: "site-ink" }), text("Route 40: gravel sections", { size: "xs", color: "on-wash" }), icon("mousePointer2", { size: 16, color: "primary" })),
]);

// Keep the project drawing shared; the detailed board opens it without a drag overlay.
export function desktopProject({ dropped = false, lyraSaved = false } = {}) {
  const root = desktopPanel({ detailed: true });
  const panel = findNode(root, "side-panel");
  if (dropped || lyraSaved) {
    const items = panel.kids.find(k => k.t === "box" && k.kids?.some(child => child.name === "item-inn"));
    items.kids.unshift(desktopItem(lyraSaved ? "Lyra: Patagonia travel notes" : "Route 40: gravel sections and fuel stops",
      lyraSaved ? "Sources: Rutas del Sur · Lago Azul Inn" : "Added just now",
      lyraSaved ? icon("sparkles", { size: 22, color: "primary" }) : badge("site-routes", { initial: "R", size: 24, radius: "sm", ink: "site-ink" }), { selected: true, ref: "added-item" }));
    items.kids.pop();
  }
  return root.kids[0];
}
function findNode(root, name) {
  if (root.name === name) return root;
  for (const kid of root.kids ?? []) { const found = findNode(kid, name); if (found) return found; }
}

export const desktopSavedPage = () => panelWindow("Desktop", col({ gap: 4 }, note("Trip to Patagonia / Lodging"), heading("Lago Azul Inn: your booking")),
  row({ gap: 8 }, badge("site-inn", { initial: "L", size: 22, radius: "sm", ink: "site-ink" }), note("lagoazul.example")),
  pagePreview("Lago Azul Inn", "info"), col({ gap: 8 }, label("Note"), text("Allow two nights beside the lake before heading north.", { size: "sm", color: "text" })),
  col({ gap: 8 }, action("Open page", { glyph: "externalLink", ref: "item-open-page" }), action("Ask Lyra", { glyph: "sparkles", ref: "item-ask-lyra" }),
    action("Move to folder", { glyph: "folderInput", ref: "item-move" }), action("Delete", { glyph: "trash2", ref: "item-delete" })));
export const desktopNote = () => panelWindow("Desktop", note("Trip to Patagonia"),
  col({ gap: 8 }, label("Title"),
    col({ pad: [0, 0, 8, 0], edge: { side: "bottom", color: "frame" }, name: "note-title", label: "Note title" },
      heading("Budget: accommodation and car"))),
  col({ gap: 8 }, label("Text"),
    col({ pad: [0, 0, 8, 0], edge: { side: "bottom", color: "frame" }, name: "note-editor", label: "Note text" },
      text("Allow two nights beside the lake.\nKeep a reserve for fuel and gravel-road delays.", { size: "sm", color: "text" }))),
  note("Saved as you type"));
export const desktopTabGroup = () => horizonWindow(AMBER, [routesSite()], {
  tabs: [SITE_TABS[0], { ...SITE_TABS[1], group: "patagonia" }, { title: "Lago Azul Inn: your booking", color: "site-inn", initial: "L", group: "patagonia" },
    { title: "El Chaltén: trails open in April", color: "site-trails", initial: "E", group: "patagonia" }],
  active: 1, tabW: 210, groups: { patagonia: { name: "Trip to Patagonia", color: "success", glyph: "map" } }, bar: SITE_BAR, label: "Project pages as a tab group",
});

export const lyraStatus = () => note("On this computer · local model");
export const askField = (value = "Ask Lyra") => row({ h: 44, pad: [0, 4, 0, 10], gap: 8, radius: "md", fill: "field", stroke: "frame", name: "ask-field", label: "Ask Lyra" },
  text(value, { size: "sm", color: value === "Ask Lyra" ? "dim" : "title", grow: 1 }), btn("send", { label: "Send question", ref: "ask-send", tone: "primary" }));
const linkList = (title, links) => col({ gap: 6 }, label(title),
  ...links.map(([value, glyph, ref]) => quietAction(value, { glyph, ref, h: 28 })));
export const sourceChips = () => linkList("Sources", [["Rutas del Sur · Route 40", "link", "source-routes"], ["Lago Azul Inn · Booking", "link", "source-inn"]]);
export const saveLyra = () => row({ gap: 8 }, action("Save to Desktop", { primary: true, glyph: "layoutDashboard", ref: "save-desktop" }));
// A side-panel list keeps its rows 4 px apart, so it reads as one group under its label.
const panelList = (...rows) => col({ gap: 4 }, ...rows);
export const lyraHome = () => panelWindow("Lyra", titleBlock("Lyra", lyraStatus(), note("Short answers by default")),
  panelList(menuRow("Summarise this page", { glyph: "fileText", ref: "suggest-summary", h: 36 }),
    menuRow("Compare open tabs", { glyph: "columns2", ref: "suggest-compare", h: 36 }),
    menuRow("Ask about a project", { glyph: "folder", ref: "suggest-project", h: 36 })), fill(), askField());
export const lyraMissing = () => panelWindow("Lyra", heading("Lyra"),
  text("The local model is not installed on this computer.", { size: "sm", color: "text" }),
  action("Install the local model", { primary: true, glyph: "download", ref: "install-model" }),
  { ...action("Use a free cloud tier or your own key", { ghost: true, ref: "use-cloud" }), kids: [text("Use a free cloud tier or your own key", { size: "xs", color: "soft" })] });
export const cloudDialog = () => popover({ w: 560, pad: 24, gap: 18, radius: "xl", shadow: false, name: "cloud-warning", label: "Before using the cloud" },
  heading("Before using the cloud"), label("Provider chosen"), dropdown("OpenRouter · free tier", { ref: "cloud-provider" }),
  text("Your questions and the pages Lyra reads leave this computer for OpenRouter, the provider you chose. Any data collection that follows is your responsibility.", { size: "sm", color: "text" }),
  row({ gap: 10, justify: "end" }, { ...action("Cancel", { ref: "cloud-cancel" }), stroke: "primary", strokeWidth: 2, label: "Cancel, focused" }, action("Continue", { primary: true, ref: "cloud-continue" })));
export const lyraComparePick = () => panelWindow("Lyra", titleBlock("Choose tabs", lyraStatus()),
  panelList(...[["Rutas del Sur · Route 40", "site-routes", "R", true], ["Lago Azul Inn · Your booking", "site-inn", "L", true], ["Sourdough bread", "site-bread", "S", false]].map(([title, color, initial, on], i) => menuRow(title, {
    h: 36, ref: `compare-tab-${i}`, lead: row({ gap: 10 }, { ...checkbox(on), radius: "xs" }, badge(color, { initial, size: 20, radius: "xs", ink: "site-ink" })),
  }))), action("Compare", { primary: true, ref: "compare-tabs" }));
export const lyraProjectAsk = () => panelWindow("Lyra", titleBlock("Ask about a project", lyraStatus()),
  col({ gap: 8 }, label("Project"), col({ gap: 6 }, dropdown("Trip to Patagonia", { lead: icon("folder", { size: 16, color: "primary" }), ref: "lyra-project" }),
    note("9 items · pages, captures and notes"))), fill(), askField("What is still left to book?"));
export const lyraComparison = () => panelWindow("Lyra", titleBlock("Comparison", lyraStatus()), bubble("Compare these two pages"),
  answer("Route: Rutas del Sur covers gravel and fuel stops;\nLago Azul Inn gives a base beside the lake.\nTiming: drive the long section by day; stay two nights before heading north.\nNext step: check a room and allow time for slow roads."),
  sourceChips(), saveLyra(), fill(), askField());
export const lyraProjectAnswer = () => panelWindow("Lyra", titleBlock("Trip to Patagonia", lyraStatus()), bubble("What is still left to book?"),
  answer("Book the rental car and the second night's room. Your Lago Azul booking covers the first night; the budget note leaves both costs open."),
  linkList("Project items", [["Lago Azul Inn: your booking", "link", "answer-booking"], ["Budget: accommodation and car", "fileText", "answer-budget"]]),
  saveLyra(), fill(), askField());
// The attached screenshot belongs to the question, so it sits on the question's side, just above it.
export const lyraCaptureAnswer = () => panelWindow("Lyra", titleBlock("Lyra", lyraStatus()),
  col({ gap: 6 }, row({ justify: "end" }, screenshotPreview(280, "attached")), bubble("What does this map show?")), answer("It shows the gravel sections of Route 40 and the towns where you can refuel. The longest gravel stretch is about 70 km."),
  note("Source: attached screenshot · Rutas del Sur"), saveLyra(), fill(), askField());

// ---- settings ---------------------------------------------------------------

const SETTINGS = [["settings2", "General"], ["palette", "Appearance"], ["shieldCheck", "Privacy"], ["users", "Profiles"], ["refreshCw", "Sync"], ["puzzle", "Extensions"], ["sparkles", "Lyra"]];
// The rail's title shares its line with the page title beside it: same top padding, same line height.
export const settingsRail = (chosen) => col(
  { w: 280, pad: [32, 20, 20, 20], gap: 2, fill: "chrome", edge: { side: "right", color: "line" }, name: "settings-nav", label: "Settings sections" },
  row({ h: 41, gap: 12, pad: [0, 8] }, mark(28), text("Settings", { size: "lg", weight: 650, color: "title" })), space(16),
  ...SETTINGS.map(([glyph, name]) => menuRow(name, { glyph, active: name === chosen, h: 38, ref: `settings-${slug(name)}` })),
);
// A section's own page under the rail; a page inside a section leads with the way back to it.
export const settingsPage = (title, ...kids) => col({ w: 1020, pad: [32, 56], gap: 24, name: `${slug(title)}-settings`, label: title },
  text(title, { size: "2xl", weight: 650, color: "title" }), ...kids);
export const settingsSubpage = (parent, title, ...kids) => col({ w: 1020, pad: [32, 56], gap: 24, name: `${slug(title)}-settings`, label: title },
  col({ gap: 4 }, { ...action(parent, { ghost: true, glyph: "chevronLeft", h: 20, ref: `back-${slug(parent)}` }), pad: 0, justify: "start", self: "start" },
    text(title, { size: "2xl", weight: 650, color: "title" })), ...kids);
export const settingsCard = (...rows) => col({ pad: [0, 20], radius: "lg", fill: "surface", stroke: "line" }, ...rows);
export const settingsGroup = (title, ...rows) => col({ gap: 8 }, label(title), settingsCard(...rows));
export const settingRow = (title, hint, control) => row({ pad: [16, 0], gap: 24, name: slug(title), label: title },
  col({ grow: 1, gap: 4 }, text(title, { size: "sm", weight: 600, color: "title" }), hint ? note(hint) : null), control);
export const settingsWindow = (theme, section, page, overlays) => horizonWindow(theme, [row({ w: 1440, h: PAGE_H, align: "stretch", place: { x: 0, y: 0 } }, settingsRail(section), page)],
  { tabs: [{ title: "Settings", own: true }, SITE_TABS[1]], bar: { value: section === "General" ? "horizon://settings" : `horizon://settings/${slug(section)}`, blocked: null }, label: "Settings", overlays });
export const settingsGeneral = () => settingsWindow(AMBER, "General", settingsPage("General",
  settingsCard(
    settingRow("Default browser", "Horizon is not your default browser", action("Make default", { ref: "make-default" })), hr(),
    settingRow("On start", null, seg(["Tabs from last time", "A new page"], "Tabs from last time", { ref: "on-start" })), hr(),
    settingRow("Search engine", "For the address bar and the start page", dropdown("DuckDuckGo", { w: 220, h: 32, ref: "search-engine" })), hr(),
    settingRow("Downloads", "C:\\Users\\Ana\\Downloads", action("Change", { glyph: "folder", ref: "downloads-folder" })), hr(),
    settingRow("Ask where to save each download", null, switcher(false, { ref: "ask-where-to-save-each-download-switch", label: "Ask where to save each download" })), hr(),
    settingRow("Language", "Horizon follows Windows unless you choose one", dropdown("System (English)", { w: 220, h: 32, ref: "language" })), hr(),
    settingRow("Import from Edge", "Favorites with their folders, and history", action("Import", { ref: "import-edge" })),
  )));
