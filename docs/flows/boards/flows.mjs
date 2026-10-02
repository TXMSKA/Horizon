// Horizon's flows, asked for by the owner on 2026-10-01 to review the plan: how the
// browser is used, step by step, in the approved window (identity board,
// Familia Nebula, Amber; the sync screen wears Daylight). Each screen carries
// a short note the viewer shows when the screen is clicked. Rows follow
// the plan: browsing and privacy, profiles, research with Lyra and notebooks,
// then passwords, extensions and sync. The sites and the data are invented.

import { board } from "blueprint/board.mjs";
import { box, col, row, stack, text, icon, space, fill, locate } from "blueprint/kit.mjs";
import { action, badge, dot, hr, input, label, popover, seg, switcher } from "blueprint/ui.mjs";
import { AMBER, DAYLIGHT, NOTES, horizonWindow, mark, noteRow, slug, startPage, tabStrip } from "../kit/horizon.mjs";

// ---- invented sites ---------------------------------------------------------

const SITE_TABS = [
  { title: "Home", glyph: "house" },
  { title: "Route 40: gravel sections and fuel stops", color: "#2f6b4f", initial: "R" },
  { title: "Sourdough bread: the complete guide", color: "#745642", initial: "S" },
];

// A site's own colours, light as published, and as Horizon's dark mode
// repaints it.
const ROUTES = {
  light: { bg: "#f7f5f0", card: "#ffffff", ink: "#1c2a22", soft: "#56655c", accent: "#2f6b4f", img: "#cdd6cc" },
  dark: { bg: "#151719", card: "#1d2023", ink: "#e4e7e4", soft: "#a3aba6", accent: "#86c9a6", img: "#323839" },
};

/** Rutas del Sur, a travel article. */
function routesSite({ dark = false, width = 1440 } = {}) {
  const p = dark ? ROUTES.dark : ROUTES.light;
  const side = (width - 800) / 2;
  return col(
    { w: width, h: 804, fill: p.bg, place: { x: 0, y: 0 }, name: "site", label: "Site: Rutas del Sur" },
    row(
      { h: 64, pad: [0, side], gap: 28, fill: p.card },
      text("Rutas del Sur", { face: "serif", size: 22, weight: 700, color: p.ink }),
      fill(),
      ...["Routes", "Weather", "Maps", "Subscribe"].map((item) => text(item, { size: "sm", color: p.soft })),
    ),
    col(
      { pad: [40, side, 0, side], gap: 14 },
      text("Patagonia", { size: "xs", weight: 700, color: p.accent, upper: true, track: 0.08 }),
      text("Route 40: gravel sections and fuel stops", { face: "serif", size: 38, color: p.ink, lh: 1.2 }),
      text("By Lucía Ferrer. 12 minute read.", { size: "sm", color: p.soft }),
      space(6),
      box({ h: 230, radius: 12, fill: p.img, name: "site-photo", label: "Article photo" }),
      space(6),
      text("Three gravel sections remain between El Calafate and Perito Moreno. The longest runs for about 70 kilometres and is best driven by day, on tyres in good shape.", { size: "base", color: p.ink }),
      text("There can be more than 200 kilometres between two fuel stations: fill up in every town, even when the tank is not empty.", { size: "base", color: p.ink }),
    ),
  );
}

// ---- small pieces -------------------------------------------------------------

const note = (value) => text(value, { size: "xs", color: "soft" });

/** A settings line: a label, an optional hint and a switch. */
function switchRow(title, on, { hint, ref } = {}) {
  return row(
    { h: hint ? 52 : 40, gap: 12, name: ref ?? slug(title), label: title },
    col({ grow: 1, gap: 2 }, text(title, { size: "sm", color: "title" }), hint ? note(hint) : null),
    switcher(on, { ref: `${ref ?? slug(title)}-switch`, label: title }),
  );
}

/** Lyra's panel, docked on the right of the page. */
function lyraPanel(...kids) {
  return col(
    { w: 400, pad: 20, gap: 16, fill: "surface", edge: { side: "left", color: "line" }, name: "lyra-panel", label: "Lyra panel" },
    row(
      { gap: 10 },
      icon("sparkles", { size: 18, color: "primary" }),
      text("Lyra", { size: "base", weight: 650, color: "title" }),
      fill(),
      text("Local model", { size: "xs", color: "soft" }),
      icon("x", { size: 16, color: "soft" }),
    ),
    hr(),
    ...kids,
  );
}

const bubble = (value, { mine = false } = {}) =>
  row(
    { justify: mine ? "end" : "start" },
    box({ pad: [10, 14], radius: "lg", fill: mine ? "wash" : "surface-2", w: mine ? undefined : 360 }, text(value, { size: "sm", color: mine ? "on-wash" : "text" })),
  );

const SITE_BAR = { value: "rutasdelsur.example/ruta-40", blocked: 23 };

// ---- browsing and privacy -------------------------------------------------------

const home = () => horizonWindow(AMBER, [startPage()]);

const SUGGESTIONS = [
  { glyph: "search", title: "Search the web for “route 40”" },
  { glyph: "history", title: "Route 40: gravel sections and fuel stops", hint: "rutasdelsur.example" },
  { glyph: "star", title: "Full map of Route 40", hint: "Bookmarks" },
  { glyph: "notebookPen", title: "Trip to Patagonia", hint: "Notebook" },
];

const searching = () =>
  horizonWindow(AMBER, [startPage()], {
    bar: { value: "route 40", focus: true },
    overlays: [
      popover(
        { w: 1180, place: { x: 130, y: 92 }, name: "suggestions", label: "Suggestions" },
        ...SUGGESTIONS.map((item, i) =>
          row(
            { h: 40, pad: [0, 12], gap: 12, radius: "sm", fill: i === 1 ? "wash" : undefined, name: `suggestion-${i + 1}`, label: item.title },
            icon(item.glyph, { size: 16, color: i === 1 ? "primary" : "soft" }),
            text(item.title, { size: "sm", color: "title" }),
            fill(),
            item.hint ? text(item.hint, { size: "xs", color: "soft" }) : null,
          ),
        ),
      ),
    ],
  });

const site = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Site" });

const shieldPopover = () =>
  popover(
    { w: 380, pad: 16, gap: 12, place: { x: 130, y: 92 }, name: "shield-panel", label: "Blocking on this site" },
    row({ gap: 10 }, badge("#2f6b4f", { initial: "R", size: 24, radius: 6 }), text("rutasdelsur.example", { size: "sm", weight: 600, color: "title" })),
    hr(),
    switchRow("Block ads and trackers", true, { hint: "23 blocked: 15 ads, 6 trackers and 2 cookies", ref: "blocking" }),
    switchRow("Dark mode on this site", false, { ref: "site-dark" }),
    hr(),
    label("Permissions"),
    row({ h: 32, gap: 10 }, icon("map", { size: 16, color: "soft" }), text("Location", { size: "sm", color: "title" }), fill(), text("Ask", { size: "sm", color: "soft" })),
    row({ h: 32, gap: 10 }, icon("bell", { size: 16, color: "soft" }), text("Notifications", { size: "sm", color: "title" }), fill(), text("Blocked", { size: "sm", color: "soft" })),
  );

const shield = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, overlays: [shieldPopover()], label: "Site" });

const dark = () =>
  horizonWindow(AMBER, [routesSite({ dark: true })], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Site in dark mode" });

// ---- profiles ---------------------------------------------------------------------

const profileRow = (name, color, active, hint) =>
  row(
    { h: 44, pad: [0, 10], gap: 10, radius: "sm", fill: active ? "wash" : undefined, name: `profile-${slug(name)}`, label: name },
    dot(color, 10),
    col({ grow: 1, gap: 0 }, text(name, { size: "sm", weight: active ? 600 : 400, color: "title" }), note(hint)),
    active ? icon("check", { size: 16, color: "primary" }) : null,
  );

const profiles = () =>
  horizonWindow(AMBER, [startPage()], {
    overlays: [
      popover(
        { w: 280, place: { x: 10, y: 42 }, name: "profiles", label: "Profiles" },
        profileRow("Personal", "primary", true, "3 tabs"),
        profileRow("Work", "info", false, "8 tabs"),
        hr(),
        row({ h: 36, pad: [0, 10], gap: 10, name: "new-profile", label: "New profile" }, icon("plus", { size: 16, color: "soft" }), text("New profile", { size: "sm", color: "title" })),
        row({ h: 36, pad: [0, 10], gap: 10, name: "manage-profiles", label: "Manage profiles" }, icon("settings2", { size: 16, color: "soft" }), text("Manage profiles", { size: "sm", color: "title" })),
      ),
    ],
  });

// ---- tab groups ---------------------------------------------------------------------

// The owner, 2026-10-01: tabs can be grouped, each group with its own name, colour
// and icon: any colour from a picker, and any icon of the set, found by
// search. The suggested colours are drawn for Amber; each theme gets its own
// set at contrast when the task is built.
const GROUP_COLORS = ["#7cc4a0", "#a4b6ff", "#ffb04a", "#ff8a8a", "#d7a4ff", "#f3c460", "#7fd1e0", "#c4b3b6"];

// What a search for "trip" finds: icons are tagged in English and Spanish.
const TRIP_ICONS = ["map", "plane", "car", "route", "compass", "globe", "trees", "briefcase"];

// The colour being picked, and where it sits in the picker: hue near 166
// degrees on the strip, saturation and brightness in the area above it.
const PICKED = "#4fb39a";

const GROUPS = {
  trip: { name: "Trip", color: "#7cc4a0", glyph: "map" },
  cooking: { name: "Cooking", color: "#d7a4ff", glyph: "utensils" },
};

const GROUP_STRIP = {
  tabs: [
    SITE_TABS[0],
    { ...SITE_TABS[1], group: "trip" },
    { title: "Lago Azul Inn: your booking", color: "#1f5f8b", initial: "L", group: "trip" },
    { title: "El Chaltén: trails open in April", color: "#5b7f3a", initial: "E", group: "trip" },
    { ...SITE_TABS[2], group: "cooking" },
  ],
  active: 1,
  groups: GROUPS,
  tabW: 168,
};

const swatch = (color, on) =>
  stack(
    { w: 26, h: 26, radius: "pill", stroke: on ? "title" : undefined, strokeWidth: 2, name: `color-${color.slice(1)}`, label: on ? "Chosen colour" : "Colour" },
    box({ w: 18, h: 18, radius: "pill", fill: color, place: "center" }),
  );

const customSwatch = () =>
  stack(
    { w: 26, h: 26, radius: "pill", stroke: "line-strong", dash: "3 3", name: "color-custom", label: "Custom colour" },
    icon("plus", { size: 14, color: "soft", place: "center" }),
  );

const iconChoice = (glyph, on, color) =>
  stack(
    { w: 30, h: 30, radius: "sm", fill: on ? "surface-3" : undefined, name: `icon-${slug(glyph)}`, label: on ? "Chosen icon" : "Icon" },
    icon(glyph, { size: 16, color: on ? color : "soft", place: "center" }),
  );

/** The custom colour picker: saturation and brightness, the hue strip, and the hex value. */
function colorPicker(place) {
  return popover(
    {
      w: 248,
      pad: 14,
      gap: 12,
      place,
      // The picker's gradients come from this repository's skin defs.
      theme: { "sv-hue": "url(#rv-hz-sv-hue)", "sv-dark": "url(#rv-hz-sv-dark)", "hue-strip": "url(#rv-hz-hue)" },
      name: "color-picker",
      label: "Custom colour",
    },
    stack(
      { h: 150, radius: "md", clip: true, name: "color-area", label: "Saturation and brightness" },
      box({ fill: "sv-hue" }),
      box({ fill: "sv-dark" }),
      stack({ w: 16, h: 16, radius: "pill", stroke: "#ffffff", strokeWidth: 2, place: { x: 115, y: 37 } }),
    ),
    stack(
      { h: 16, name: "hue", label: "Hue" },
      box({ w: 220, h: 10, radius: "pill", fill: "hue-strip", place: { x: 0, y: 3 } }),
      stack({ w: 16, h: 16, radius: "pill", fill: "#00c2a0", stroke: "#ffffff", strokeWidth: 2, place: { x: 93, y: 0 } }),
    ),
    row(
      { gap: 8 },
      box({ w: 34, h: 34, radius: "md", fill: PICKED }),
      input(PICKED, { glyph: null, value: PICKED, grow: 1 }),
      action("Use", { primary: true, ref: "use-color" }),
    ),
  );
}

function groups() {
  const group = GROUPS.trip;
  const at = locate(tabStrip(GROUP_STRIP), 1440, "group-trip");
  const top = at.y + at.h + 8;
  return horizonWindow(AMBER, [routesSite()], {
    ...GROUP_STRIP,
    bar: SITE_BAR,
    label: "Site",
    overlays: [
      popover(
        { w: 316, pad: 14, gap: 10, place: { x: at.x, y: top }, name: "group-editor", label: "Edit group" },
        label("Name"),
        input("Group name", { glyph: null, value: group.name }),
        label("Colour"),
        row({ gap: 6 }, ...GROUP_COLORS.map((color) => swatch(color, color === group.color)), customSwatch()),
        label("Icon"),
        input("Search icons", { value: "trip", focus: true }),
        row({ gap: 6 }, ...TRIP_ICONS.map((glyph) => iconChoice(glyph, glyph === group.glyph, group.color))),
        text("8 icons for “trip”", { size: "xs", color: "soft" }),
      ),
      colorPicker({ x: at.x + 316 + 8, y: top + 104 }),
    ],
  });
}

// ---- research -----------------------------------------------------------------------

const lyraPermission = () =>
  horizonWindow(AMBER, [routesSite({ width: 1040 })], {
    tabs: SITE_TABS,
    active: 1,
    bar: SITE_BAR,
    label: "Site",
    side: lyraPanel(
      bubble("Summarise this page", { mine: true }),
      col(
        { pad: 16, gap: 10, radius: "lg", fill: "surface-2", stroke: "line", name: "lyra-permission", label: "Permission to read" },
        text("Can I read this page?", { size: "base", weight: 650, color: "title" }),
        text("To summarise it I need to read rutasdelsur.example. I run on your computer: nothing leaves it.", { size: "sm", color: "text" }),
        space(4),
        action("Allow on this site", { primary: true, ref: "allow-site" }),
        row({ gap: 8 }, action("Just this once", { grow: 1, ref: "allow-once" }), action("No", { grow: 1, ref: "deny" })),
      ),
    ),
  });

const lyraSummary = () =>
  horizonWindow(AMBER, [routesSite({ width: 1040 })], {
    tabs: SITE_TABS,
    active: 1,
    bar: SITE_BAR,
    label: "Site",
    side: lyraPanel(
      bubble("Summarise this page", { mine: true }),
      bubble("Three gravel sections remain; the longest is about 70 km and best driven by day. Stations can be more than 200 km apart, so fill up in every town."),
      row({ gap: 8 }, action("Save to notebook", { primary: true, glyph: "notebookPen", ref: "save-note" }), action("Compare", { glyph: "columns2", ref: "compare" })),
      fill(),
      row({ h: 40, pad: [0, 12], gap: 10, radius: "md", fill: "field", stroke: "field-line", name: "ask-lyra", label: "Ask Lyra" }, text("Ask Lyra", { size: "sm", color: "dim" }), fill(), icon("send", { size: 16, color: "primary" })),
    ),
  });

const capture = () =>
  horizonWindow(AMBER, [routesSite(), box({ w: 1440, h: 804, fill: "rgba(0, 0, 0, 0.45)", place: { x: 0, y: 0 } }), box({ w: 820, h: 300, radius: 6, stroke: "primary", strokeWidth: 2, dash: "6 4", fill: "rgba(255, 176, 74, 0.08)", place: { x: 310, y: 262 }, name: "selection", label: "Chosen area" })], {
    tabs: SITE_TABS,
    active: 1,
    bar: SITE_BAR,
    label: "Capture",
    overlays: [
      row(
        { h: 48, pad: [0, 8], gap: 10, radius: "lg", fill: "surface", stroke: "line-strong", place: { x: 430, y: 116 }, name: "capture-bar", label: "Capture bar" },
        seg([{ label: "Text", icon: "type" }, { label: "Area", icon: "squareDashed" }, { label: "Full page", icon: "appWindow" }], "Area", { ref: "capture-kind" }),
        action("Save to notebook", { primary: true, glyph: "notebookPen", ref: "capture-save" }),
        action("Cancel", { ghost: true, ref: "capture-cancel" }),
      ),
    ],
  });

const NOTEBOOK_TABS = [{ title: "Trip to Patagonia", glyph: "notebookPen" }, SITE_TABS[1], SITE_TABS[2]];

const notebook = () =>
  horizonWindow(
    AMBER,
    [
      row(
        { w: 1440, h: 804, place: { x: 0, y: 0 }, align: "stretch" },
        col(
          { w: 360, pad: 20, gap: 4, fill: "surface", edge: { side: "right", color: "line" }, name: "notebook-list", label: "Notes and captures" },
          text("Trip to Patagonia", { size: "lg", weight: 650, color: "title" }),
          note("6 notes and 3 captures"),
          space(12),
          row({ h: 50, gap: 12, radius: "sm", fill: "wash", pad: [0, 10], name: "item-capture", label: "Capture: gravel sections" }, icon("camera", { size: 16, color: "primary" }), text("Capture: gravel sections", { size: "sm", weight: 600, color: "title" })),
          ...NOTES.map((item) => noteRow(item, { source: false })),
        ),
        col(
          { grow: 1, pad: [28, 48], gap: 16, name: "notebook-item", label: "Open capture" },
          row(
            { gap: 10 },
            text("Capture: gravel sections", { size: "xl", weight: 650, color: "title" }),
            fill(),
            action("Send to", { glyph: "send", ref: "send-to" }),
          ),
          note("From rutasdelsur.example, today"),
          box({ h: 300, radius: "lg", fill: "#cdd6cc", name: "capture-image", label: "Captured image" }),
          text("Drive the long section by day. Fill up in every town.", { size: "base", color: "text" }),
        ),
      ),
    ],
    {
      tabs: NOTEBOOK_TABS,
      active: 0,
      bar: { value: "horizon://notebooks/trip-to-patagonia", blocked: null },
      label: "Notebook",
      overlays: [
        popover(
          { w: 220, place: { x: 1170, y: 168 }, name: "send-menu", label: "Send to" },
          ...[["fileText", "Docs"], ["penTool", "Blueprint"], ["codeXml", "Nova"]].map(([glyph, app]) =>
            row({ h: 36, pad: [0, 10], gap: 10, radius: "sm", name: `send-${slug(app)}`, label: app }, icon(glyph, { size: 16, color: "soft" }), text(app, { size: "sm", color: "title" })),
          ),
        ),
      ],
    },
  );

// ---- passwords, extensions and sync ---------------------------------------------------

const INN = { bg: "#eef2f5", card: "#ffffff", ink: "#16222c", soft: "#5b6872", line: "#cfd8df", accent: "#1f5f8b" };
const LOGIN_TABS = [SITE_TABS[0], { title: "Lago Azul Inn: your booking", color: "#1f5f8b", initial: "L" }];

const vault = () =>
  horizonWindow(
    AMBER,
    [
      col(
        { w: 1440, h: 804, fill: INN.bg, align: "center", pad: [96, 0], place: { x: 0, y: 0 }, name: "site", label: "Site: Lago Azul Inn" },
        col(
          { w: 420, pad: 32, gap: 12, radius: 12, fill: INN.card, stroke: INN.line },
          text("Lago Azul Inn", { face: "serif", size: 22, weight: 700, color: INN.ink }),
          text("Sign in to see your booking", { size: "sm", color: INN.soft }),
          space(8),
          text("Email", { size: "sm", weight: 600, color: INN.ink }),
          box({ h: 40, radius: 6, stroke: INN.accent, strokeWidth: 2, fill: INN.card, name: "email", label: "Email" }),
          space(150),
          text("Password", { size: "sm", weight: 600, color: INN.ink }),
          box({ h: 40, radius: 6, stroke: INN.line, fill: INN.card }),
          space(6),
          row({ h: 42, radius: 6, fill: INN.accent, justify: "center" }, text("Sign in", { size: "sm", weight: 600, color: "#ffffff" })),
        ),
      ),
    ],
    {
      tabs: LOGIN_TABS,
      active: 1,
      bar: { value: "lagoazul.example/sign-in", blocked: 4 },
      label: "Site",
      overlays: [
        popover(
          { w: 356, pad: 10, gap: 6, place: { x: 542, y: 396 }, name: "vault", label: "Vault" },
          row({ gap: 8, pad: [4, 6] }, icon("keyRound", { size: 16, color: "primary" }), text("Vault", { size: "sm", weight: 650, color: "title" })),
          row(
            { h: 48, pad: [0, 10], gap: 10, radius: "sm", fill: "wash", name: "vault-account", label: "Saved account" },
            badge("#1f5f8b", { initial: "L", size: 24, radius: 6 }),
            col({ grow: 1, gap: 0 }, text("ana.ferrer@example.com", { size: "sm", weight: 600, color: "title" }), note("lagoazul.example")),
          ),
          row({ gap: 8, pad: [4, 6] }, icon("fingerprint", { size: 14, color: "soft" }), note("Asks for your fingerprint or Windows PIN before filling in")),
        ),
      ],
    },
  );

const STORE_TABS = [SITE_TABS[0], { title: "Quick Translator: Chrome Web Store", color: "#4a6fa5", initial: "Q" }];

const extension = () =>
  horizonWindow(
    AMBER,
    [
      col(
        { w: 1440, h: 804, fill: "#f4f6f8", pad: [40, 240], gap: 20, place: { x: 0, y: 0 }, name: "site", label: "Chrome Web Store" },
        text("Chrome Web Store", { size: "sm", color: "#4f5b66" }),
        row(
          { gap: 20, pad: 24, radius: 12, fill: "#ffffff", stroke: "#d8dee4" },
          badge("#4a6fa5", { glyph: "languages", size: 64, radius: 14 }),
          col({ grow: 1, gap: 4 }, text("Quick Translator", { size: "xl", weight: 650, color: "#1b2530" }), text("Translates the page or your selection.", { size: "sm", color: "#4f5b66" })),
          row({ h: 40, pad: [0, 18], radius: 8, fill: "#4a6fa5", justify: "center", name: "add-extension", label: "Add" }, text("Add", { size: "sm", weight: 600, color: "#ffffff" })),
        ),
      ),
      box({ w: 1440, h: 804, fill: "overlay", place: { x: 0, y: 0 } }),
      col(
        { w: 460, pad: 24, gap: 12, radius: "xl", fill: "surface", stroke: "line-strong", place: { x: 490, y: 240 }, name: "extension-warning", label: "Warning before installing" },
        row({ gap: 10 }, icon("triangleAlert", { size: 20, color: "warning" }), text("This extension may not work well", { size: "base", weight: 650, color: "title" })),
        text("It uses features Horizon does not have yet, such as reading tabs in the background.", { size: "sm", color: "text" }),
        space(6),
        row({ gap: 8, justify: "end" }, action("Install anyway", { ghost: true, ref: "install-anyway" }), action("Cancel", { primary: true, ref: "cancel-install" })),
      ),
    ],
    { tabs: STORE_TABS, active: 1, bar: { value: "chromewebstore.google.com/detail/quick-translator", blocked: 2 }, label: "Store" },
  );

const SETTINGS = [["settings2", "General"], ["palette", "Appearance"], ["shieldCheck", "Privacy"], ["users", "Profiles"], ["refreshCw", "Sync"], ["puzzle", "Extensions"], ["sparkles", "Lyra"]];

const sync = () =>
  horizonWindow(
    DAYLIGHT,
    [
      row(
        { w: 1440, h: 804, place: { x: 0, y: 0 }, align: "stretch" },
        col(
          { w: 280, pad: 20, gap: 2, fill: "chrome", edge: { side: "right", color: "line" }, name: "settings-nav", label: "Settings sections" },
          row({ gap: 12, pad: [0, 8, 16, 8] }, mark(28), text("Settings", { size: "lg", weight: 650, color: "title" })),
          ...SETTINGS.map(([glyph, name]) =>
            row({ h: 38, pad: [0, 10], gap: 10, radius: "sm", fill: name === "Sync" ? "wash" : undefined, name: `settings-${slug(name)}`, label: name }, icon(glyph, { size: 16, color: name === "Sync" ? "primary" : "soft" }), text(name, { size: "sm", weight: name === "Sync" ? 600 : 400, color: "title" })),
          ),
        ),
        col(
          { w: 680, pad: [32, 56], gap: 8, name: "sync-settings", label: "Sync" },
          text("Sync", { size: "2xl", weight: 650, color: "title" }),
          row({ gap: 8 }, icon("lock", { size: 14, color: "success" }), text("End-to-end encrypted: Nebula cannot read your data.", { size: "sm", color: "text" })),
          space(16),
          col(
            { pad: [8, 20], radius: "lg", fill: "surface", stroke: "line" },
            switchRow("Profiles", true),
            hr(),
            switchRow("Bookmarks", true),
            hr(),
            switchRow("Open tabs", true),
            hr(),
            switchRow("Notebooks", true),
            hr(),
            switchRow("History", false, { hint: "Off on this computer" }),
          ),
          space(10),
          note("Used: 120 MB of 5 GB"),
        ),
      ),
    ],
    { tabs: [{ title: "Settings", glyph: "settings2" }, SITE_TABS[1]], active: 0, bar: { value: "horizon://settings/sync", blocked: null }, label: "Settings" },
  );

export default board({
  id: "flows",
  title: "Flows",
  note: "How Horizon is used, step by step. Click a screen and this box explains that step. The sites and the data are invented.",
  screens: [
    { id: "inicio", title: "1. Home", col: 0, row: 0, root: home, note: "Opening Horizon, you search or type an address. Below, you pick up your last notebook." },
    { id: "buscar", title: "2. Search", col: 1, row: 0, root: searching, note: "As you type, it suggests from your history, bookmarks and notebooks." },
    { id: "sitio", title: "3. Site open", col: 2, row: 0, root: site, note: "The site opens in its tab. The shield counts what was blocked: 23 things here." },
    { id: "escudo", title: "4. Site blocking", col: 3, row: 0, root: shield, note: "If the site breaks, blocking turns off with one click. Dark mode and permissions live here too." },
    { id: "oscuro", title: "5. Dark mode", col: 4, row: 0, root: dark, note: "The site reads dark even when it has no dark theme of its own. It is chosen per site." },
    { id: "perfiles", title: "6. Profiles", col: 0, row: 1, root: profiles, note: "Each profile has its own cookies, history and accounts. Personal and Work never mix." },
    { id: "grupos", title: "7. Tab groups", col: 1, row: 1, root: groups, note: "Tabs group under a name, colour and icon of your own. Any icon can be searched and any colour chosen." },
    { id: "lyra-permiso", title: "8. Lyra asks first", col: 2, row: 1, root: lyraPermission, note: "Lyra reads a page only when asked. The first time on each site, she asks for permission." },
    { id: "lyra-resumen", title: "9. Lyra summarises", col: 3, row: 1, root: lyraSummary, note: "She summarises or compares tabs on your computer, and you keep it in a notebook." },
    { id: "captura", title: "10. Capture", col: 2, row: 2, root: capture, note: "Capture a text, an area or the whole page. It goes to a notebook first." },
    { id: "notebook", title: "11. Notebook", col: 4, row: 1, root: notebook, note: "Notes and captures together. From here you send something to Docs, Blueprint or Nova." },
    { id: "vault", title: "12. Vault fills in", col: 0, row: 3, root: vault, note: "Vault suggests your account only on the right site, and asks for your fingerprint or PIN before filling in." },
    { id: "extension", title: "13. Extensions", col: 1, row: 3, root: extension, note: "Extensions install from the Chrome Web Store. When one uses something Horizon lacks, it warns first." },
    { id: "sync", title: "14. Sync (Daylight theme)", col: 2, row: 3, root: sync, note: "Everything syncs encrypted through Nebula's cloud. Turn off what you do not want synced." },
  ],
  links: [
    { from: "inicio", to: "buscar", at: "search", label: "Type" },
    { from: "buscar", to: "sitio", at: "suggestion-2", label: "Open" },
    { from: "sitio", to: "escudo", at: "shield", label: "Shield" },
    { from: "escudo", to: "oscuro", at: "site-dark-switch", label: "Dark mode" },
    { from: "inicio", to: "perfiles", at: "profile", label: "Profile" },
    { from: "sitio", to: "grupos", at: "tabs", label: "Group" },
    { from: "sitio", to: "lyra-permiso", at: "lyra", label: "Lyra" },
    { from: "lyra-permiso", to: "lyra-resumen", at: "allow-site", label: "Allow" },
    { from: "lyra-resumen", to: "notebook", at: "save-note", label: "Save" },
    { from: "sitio", to: "captura", at: "notebooks", label: "Capture" },
    { from: "captura", to: "notebook", at: "capture-save", label: "Save" },
  ],
});
