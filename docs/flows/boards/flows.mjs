// Horizon screen flow agreed on 2026-10-02. Each branch advances one column.

import { board } from "blueprint/board.mjs";
import { box, col, row, stack, text, icon, space, fill, locate } from "blueprint/kit.mjs";
import { action, badge, dot, hr, input, label, popover, switcher, btn, menuRow, progress } from "blueprint/ui.mjs";
import { settingsWindow, settingsPage, settingsCard, settingRow, settingsGeneral, AMBER, DAYLIGHT, PAGE_H, PAGE_TOP, horizonWindow, slug, startPage, tabStrip, toolbar, favoritesBar, SITE_TABS, SITE_BAR, routesSite, site, capture, toolbarPopup, hub, pin, themes, desktopPanel, lyraPermission, lyraSummary, split, translate, desktop } from "../kit/horizon.mjs";

// ---- invented sites ---------------------------------------------------------

// ---- small pieces -------------------------------------------------------------

const note = (value) => text(value, { size: "xs", color: "soft" });

const panelAction = (title, options) => ({ ...action(title, options), justify: "start", ...(options.ghost ? { pad: 0 } : {}) });

// A list's leading marks share a 24 px column and its texts the column after it; foot actions follow both.
const slot = (node) => stack({ w: 24, h: 24 }, { ...node, place: "center" });
const footAction = (title, glyph, ref) => row({ h: 32, gap: 10, name: ref, label: title },
  slot(icon(glyph, { size: 16, color: "title" })), text(title, { size: "sm", weight: 600, color: "title" }));
const panelTitle = (title, ...tools) => row({ h: 32, gap: 8 }, text(title, { size: "base", weight: 650, color: "title" }), fill(), ...tools);

/** A settings line: a label, an optional hint and a switch. */
function switchRow(title, on, { hint, ref } = {}) {
  return row(
    { h: hint ? 52 : 40, gap: 12, name: ref ?? slug(title), label: title },
    col({ grow: 1, gap: 2 }, text(title, { size: "sm", color: "title" }), hint ? note(hint) : null),
    switcher(on, { ref: `${ref ?? slug(title)}-switch`, label: title }),
  );
}

// ---- browsing and privacy -------------------------------------------------------

const home = () => horizonWindow(AMBER, [startPage()]);

const SUGGESTIONS = [
  { glyph: "search", title: "Search the web for “route 40”" },
  { glyph: "history", title: "Route 40: gravel sections and fuel stops", hint: "rutasdelsur.example" },
  { glyph: "star", title: "Full map of Route 40", hint: "Bookmarks" },
  { glyph: "layoutDashboard", title: "Trip to Patagonia", hint: "Desktop" },
];

// The address bar in the toolbar, for what opens under it.
const addressBox = () => {
  const at = locate(toolbar(), 1440, "address");
  return { ...at, y: 44 + at.y };
};
const under = (at) => ({ x: at.x, y: at.y + at.h + 6 });

const searching = () => {
  const bar = addressBox();
  return horizonWindow(AMBER, [startPage()], {
    bar: { value: "route 40", focus: true },
    overlays: [
      popover(
        { w: bar.w, place: under(bar), name: "suggestions", label: "Suggestions" },
        ...SUGGESTIONS.map((item, i) =>
          row(
            { h: 40, pad: [0, 12, 0, 8], gap: 10, radius: "sm", fill: i === 1 ? "wash" : undefined, name: `suggestion-${i + 1}`, label: item.title },
            icon(item.glyph, { size: 16, color: i === 1 ? "primary" : "soft" }),
            text(item.title, { size: "sm", color: "title" }),
            fill(),
            item.hint ? text(item.hint, { size: "xs", color: "soft" }) : null,
          ),
        ),
      ),
    ],
  });
};

const shieldPopover = () =>
  popover(
    { w: 380, pad: 16, gap: 12, place: under(addressBox()), name: "shield-panel", label: "Blocking on this site" },
    row({ gap: 10 }, badge("site-routes", { ink: "site-ink", initial: "R", size: 24, radius: "sm" }), text("rutasdelsur.example", { size: "sm", weight: 600, color: "title" })),
    hr(),
    switchRow("Block ads and trackers", true, { hint: "23 blocked: 15 ads, 6 trackers and 2 cookies", ref: "blocking" }),
    switchRow("Dark mode on this site", false, { ref: "site-dark" }),
    hr(),
    col({ gap: 6 }, label("Permissions"),
      col({ gap: 4 },
        row({ h: 24, gap: 10 }, icon("map", { size: 16, color: "soft" }), text("Location", { size: "sm", color: "title" }), fill(), text("Ask", { size: "sm", color: "soft" })),
        row({ h: 24, gap: 10 }, icon("bell", { size: 16, color: "soft" }), text("Notifications", { size: "sm", color: "title" }), fill(), text("Blocked", { size: "sm", color: "soft" })))),
  );

const shield = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, overlays: [shieldPopover()], label: "Site" });

const dark = () =>
  horizonWindow(AMBER, [routesSite({ dark: true })], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Site in dark mode" });

// ---- profiles ---------------------------------------------------------------------

const profileRow = (name, color, active, hint) =>
  row(
    { h: 44, pad: [0, 10], gap: 10, radius: "sm", fill: active ? "wash" : undefined, name: `profile-${slug(name)}`, label: name },
    stack({ w: 16, h: 16 }, { ...dot(color, 10), place: "center" }),
    col({ grow: 1, gap: 0 }, text(name, { size: "sm", weight: active ? 600 : 400, color: "title" }), note(hint)),
    active ? icon("check", { size: 16, color: "primary" }) : null,
  );

// ---- tab groups ---------------------------------------------------------------------

// The owner, 2026-10-01: tabs can be grouped, each group with its own name, colour
// and icon: any colour from a picker, and any icon of the set, found by
// search. The suggested colours are drawn for Amber; each theme gets its own
// set at contrast when the task is built.
const GROUP_COLORS = ["success", "info", "primary", "error", "warning", "soft", "title", "dim"];

// What a search for "trip" finds: icons are tagged in English and Spanish.
const TRIP_ICONS = ["map", "plane", "car", "route", "compass", "globe", "trees", "briefcase"];

// The colour being picked, and where it sits in the picker: hue near 166
// degrees on the strip, saturation and brightness in the area above it.
const PICKED = "success";
const PICKED_HEX = "#4fb39a";

const GROUPS = {
  trip: { name: "Trip", color: "success", glyph: "map" },
  cooking: { name: "Cooking", color: "info", glyph: "utensils" },
};

const GROUP_STRIP = {
  tabs: [
    SITE_TABS[0],
    { ...SITE_TABS[1], group: "trip" },
    { title: "Lago Azul Inn: your booking", color: "site-inn", initial: "L", group: "trip" },
    { title: "El Chaltén: trails open in April", color: "site-trails", initial: "E", group: "trip" },
    { ...SITE_TABS[2], group: "cooking" },
  ],
  active: 1,
  groups: GROUPS,
  tabW: 168,
};

const swatch = (color, on) =>
  stack(
    { w: 26, h: 26, radius: "pill", stroke: on ? "title" : undefined, strokeWidth: 2, name: `color-${color}`, label: on ? "Chosen colour" : "Colour" },
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
      // Role-based swatches keep the picker legible in each approved palette.
      
      name: "color-picker",
      label: "Custom colour",
    },
    stack(
      { h: 150, radius: "md", clip: true, stroke: "line", name: "color-area", label: "Saturation and brightness" },
      box({ fill: "surface" }),
      ...Array.from({ length: 11 }, (_, x) => box({ w: 20, h: 150, fill: PICKED, opacity: x / 10, place: { x: x * 20, y: 0 } })),
      ...Array.from({ length: 10 }, (_, y) => box({ w: 220, h: 15, fill: "ground", opacity: y / 10, place: { x: 0, y: y * 15 } })),
      stack({ w: 16, h: 16, radius: "pill", stroke: "surface", strokeWidth: 2, place: { x: 115, y: 37 } }),
    ),
    stack(
      { h: 16, name: "hue", label: "Hue" },
      ...["error", "warning", "success", "info", "primary", "error"].map((role, i) => box({ w: 37, h: 10, fill: role, place: { x: i * 36.6, y: 3 } })),
      stack({ w: 16, h: 16, radius: "pill", fill: "primary", stroke: "surface", strokeWidth: 2, place: { x: 93, y: 0 } }),
    ),
    row(
      { gap: 8 },
      box({ w: 34, h: 34, radius: "md", fill: PICKED }),
      input(PICKED_HEX, { glyph: null, value: PICKED_HEX, grow: 1 }),
      action("Use", { primary: true, h: 34, ref: "use-color" }),
    ),
  );

}

function groups() {
  const group = GROUPS.trip;
  const at = locate(tabStrip(GROUP_STRIP), 1440, "group-trip");
  const top = at.y + at.h + 6;
  const editor = popover(
    { w: 316, pad: 14, gap: 16, place: { x: at.x, y: top }, name: "group-editor", label: "Edit group" },
    col({ gap: 6 }, label("Name"), input("Group name", { glyph: null, value: group.name })),
    col({ gap: 6 }, label("Colour"), row({ gap: 6, justify: "between" }, ...GROUP_COLORS.map((color) => swatch(color, color === group.color)), customSwatch())),
    col({ gap: 6 }, label("Icon"), input("Search icons", { value: "trip", focus: true }),
      row({ gap: 6, justify: "between" }, ...TRIP_ICONS.map((glyph) => iconChoice(glyph, glyph === group.glyph, group.color))),
      text("8 icons for “trip”", { size: "xs", color: "soft" })),
  );
  // The picker's colour area starts level with the swatch that opens it.
  const custom = locate(stack({ w: 316, h: 900 }, { ...editor, place: { x: 0, y: 0 } }), 316, "color-custom", 900);
  return horizonWindow(AMBER, [routesSite()], {
    ...GROUP_STRIP,
    bar: SITE_BAR,
    label: "Site",
    overlays: [editor, colorPicker({ x: at.x + 316 + 8, y: top + custom.y - 14 })],
  });
}

// ---- research -----------------------------------------------------------------------

// ---- passwords, extensions and sync ---------------------------------------------------

const INN = { bg: "page", card: "surface", ink: "title", soft: "soft", line: "line", accent: "info" };
const LOGIN_TABS = [SITE_TABS[0], { title: "Lago Azul Inn: your booking", color: "site-inn", initial: "L" }];

const vault = () =>
  horizonWindow(
    AMBER,
    [
      col(
        { w: 1440, h: PAGE_H, theme: DAYLIGHT, fill: INN.bg, align: "center", pad: [96, 0], place: { x: 0, y: 0 }, name: "site", label: "Site: Lago Azul Inn" },
        col(
          { w: 420, pad: 32, gap: 12, radius: "lg", fill: INN.card, stroke: INN.line },
          text("Lago Azul Inn", { face: "serif", size: 22, weight: 700, color: INN.ink }),
          text("Sign in to see your booking", { size: "sm", color: INN.soft }),
          space(8),
          text("Email", { size: "sm", weight: 600, color: INN.ink }),
          box({ h: 40, radius: "sm", stroke: INN.accent, strokeWidth: 2, fill: INN.card, name: "email", label: "Email" }),
          space(150),
          text("Password", { size: "sm", weight: 600, color: INN.ink }),
          box({ h: 40, radius: "sm", stroke: INN.line, fill: INN.card }),
          space(6),
          row({ h: 42, radius: "sm", fill: INN.accent, justify: "center" }, text("Sign in", { size: "sm", weight: 600, color: "surface" })),
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
          { w: 356, pad: 10, gap: 6, place: { x: 542, y: 430 }, name: "vault", label: "Vault" },
          row({ gap: 10, pad: [4, 10] }, slot(icon("keyRound", { size: 16, color: "primary" })), text("Vault", { size: "sm", weight: 650, color: "title" })),
          row(
            { h: 48, pad: [0, 10], gap: 10, radius: "sm", fill: "wash", name: "vault-account", label: "Saved account" },
            badge("site-inn", { ink: "site-ink", initial: "L", size: 24, radius: "sm" }),
            col({ grow: 1, gap: 0 }, text("ana.ferrer@example.com", { size: "sm", weight: 600, color: "title" }), note("lagoazul.example")),
          ),
          row({ gap: 10, pad: [4, 10] }, slot(icon("fingerprint", { size: 14, color: "soft" })), note("Asks for your fingerprint or Windows PIN\nbefore filling in")),
        ),
      ],
    },
  );

const STORE_TABS = [SITE_TABS[0], { title: "Quick Translator: Add-on Market", color: "primary", initial: "Q" }];

const extension = () =>
  horizonWindow(
    AMBER,
    [
      col(
        { w: 1440, h: PAGE_H, theme: DAYLIGHT, fill: "page", pad: [40, 240], gap: 20, place: { x: 0, y: 0 }, name: "site", label: "Add-on Market" },
        text("Add-on Market", { size: "sm", color: "soft" }),
        row(
          { gap: 20, pad: 24, radius: "lg", fill: "surface", stroke: "line" },
          badge("primary", { ink: "on-primary", glyph: "languages", size: 64, radius: "lg" }),
          col({ grow: 1, gap: 4 }, text("Quick Translator", { size: "xl", weight: 650, color: "title" }), text("Translates the page or your selection.", { size: "sm", color: "soft" })),
          row({ h: 40, pad: [0, 18], radius: "md", fill: "primary", justify: "center", name: "add-extension", label: "Add" }, text("Add", { size: "sm", weight: 600, color: "surface" })),
        ),
      ),
      box({ w: 1440, h: PAGE_H, fill: "overlay", place: { x: 0, y: 0 } }),
      col(
        { w: 460, pad: 24, gap: 12, radius: "xl", fill: "surface", stroke: "line-strong", place: { x: 490, y: 240 }, name: "extension-warning", label: "Warning before installing" },
        row({ gap: 10 }, icon("triangleAlert", { size: 20, color: "warning" }), text("This extension may not work well", { size: "base", weight: 650, color: "title" })),
        text("It uses features Horizon does not have yet, such as reading tabs in the background.", { size: "sm", color: "text" }),
        space(6),
        row({ gap: 8, justify: "end" }, action("Install anyway", { ghost: true, ref: "install-anyway" }), action("Cancel", { primary: true, ref: "cancel-install" })),
      ),
    ],
    { tabs: STORE_TABS, active: 1, bar: { value: "addons.example/quick-translator", blocked: 2 }, label: "Store" },
  );

const syncRow = (title, on, hint) => settingRow(title, hint, switcher(on, { ref: `sync-${slug(title)}`, label: title }));
const sync = () => settingsWindow(DAYLIGHT, "Sync",
  settingsPage("Sync", row({ gap: 8 }, icon("lock", { size: 14, color: "success" }), text("End-to-end encrypted: Nebula cannot read your data.", { size: "sm", color: "text" })),
    settingsCard(syncRow("Profiles", true), hr(), syncRow("Bookmarks", true), hr(), syncRow("Open tabs", true), hr(), syncRow("Desktop", true), hr(),
      syncRow("History", false, "Off on this computer")),
    note("Used: 120 MB of 5 GB")));

// ---- account, favorites and settings ---------------------------------------

const account = () => horizonWindow(AMBER, [startPage()], {
  activeButton: "avatar",
  overlays: [popover({ w: 340, pad: 14, gap: 6, place: toolbarPopup("avatar", 340), name: "account-popup", label: "Account and profiles" },
    row({ gap: 12 }, badge("primary", { initial: "AF", size: 40, ink: "on-primary" }),
      col({ grow: 1, gap: 2 }, text("Ana Ferrer", { size: "base", weight: 650, color: "title" }),
        note("ana.ferrer@example.com"), text("Nebula+", { size: "xs", color: "primary" }))),
    menuRow("Manage account", { glyph: "externalLink", ref: "manage-account" }), hr(), label("Profiles"),
    profileRow("Personal", "primary", true, "Personal space"), profileRow("Work", "info", false, "Lago Azul Studio"),
    menuRow("New profile", { glyph: "plus", ref: "new-profile" }),
    menuRow("Manage profiles", { glyph: "users", ref: "manage-profiles" }), hr(),
    menuRow("Private window", { glyph: "eyeOff", ref: "private-window" }),
    menuRow("Sign out", { glyph: "logOut", ref: "sign-out" }),
  )],
});

const privateWindow = () => horizonWindow(AMBER, [startPage({ privateWindow: true })], { privateWindow: true, tabs: [{ title: "Home", own: true }] });

const favorites = () => {
  const at = locate(favoritesBar(), 1440, "favorite-trip");
  return horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, openFolder: "Trip", overlays: [
    popover({ w: 350, pad: 8, place: { x: at.x, y: PAGE_TOP - 34 + at.y + at.h + 6 }, name: "trip-folder", label: "Trip favorites" },
      ...[["Lago Azul Inn: your booking", "L", "trip-lago-azul", "site-inn"], ["El Chaltén: trails open in April", "E", "trip-trails", "site-trails"], ["Full map of Route 40", "M", "trip-map", "site-map"]].map(([title, initial, ref, color]) =>
        menuRow(title, { ref, h: 40, lead: badge(color, { initial, size: 16, radius: "xs", ink: "site-ink" }) })),
      hr(), menuRow("Open all (3)", { glyph: "externalLink", ref: "open-all" }),
    ),
  ] });
};


// ---- the Hub and quick access ----------------------------------------------

// Window previews use the four approved palettes and their existing roles.
// ---- browser tools, opened from the three-dot menu --------------------------

const browserMenu = () => horizonWindow(AMBER, [startPage()], {
  activeButton: "menu",
  overlays: [popover({ w: 360, pad: 8, gap: 2, place: toolbarPopup("menu", 360), name: "browser-menu", label: "Browser menu" },
    menuRow("New tab", { glyph: "plus", hint: "Ctrl+T", ref: "menu-new-tab" }),
    menuRow("New window", { glyph: "appWindow", hint: "Ctrl+N", ref: "menu-new-window" }),
    menuRow("New private window", { glyph: "eyeOff", hint: "Ctrl+Shift+N", ref: "menu-private" }), hr(),
    row({ h: 34, pad: [0, 10], gap: 10, name: "menu-zoom", label: "Zoom" },
      icon("zoomIn", { size: 16, color: "soft" }), text("Zoom", { size: "sm", color: "title" }), fill(),
      row({ gap: 4 }, btn("minus", { size: 28, label: "Zoom out" }), text("100 %", { size: "xs", color: "title" }),
        btn("plus", { size: 28, label: "Zoom in" }), btn("maximize", { size: 28, label: "Fullscreen" }))),
    menuRow("Find in page", { glyph: "search", hint: "Ctrl+F", ref: "menu-find" }), hr(),
    menuRow("Favorites", { glyph: "star", hint: "Ctrl+Shift+O", ref: "menu-favorites" }),
    menuRow("History", { glyph: "history", hint: "Ctrl+H", ref: "menu-history" }),
    menuRow("Downloads", { glyph: "download", hint: "Ctrl+J", ref: "menu-downloads" }),
    menuRow("Passwords", { glyph: "keyRound", ref: "menu-passwords" }),
    menuRow("Extensions", { glyph: "puzzle", ref: "menu-extensions" }), hr(),
    menuRow("Settings", { glyph: "settings2", ref: "menu-settings" }),
    menuRow("About Horizon", { glyph: "info", ref: "menu-about" })),
  ],
});

const extensions = () => horizonWindow(AMBER, [startPage()], {
  activeButton: "extensions",
  overlays: [popover({ w: 360, pad: 14, gap: 8, place: toolbarPopup("extensions", 360), name: "extensions-popup", label: "Extensions" },
    panelTitle("Extensions"),
    col({ gap: 0 }, ...[["Quick Translator", "languages", true, "primary"], ["Calm Reader", "bookOpen", false, "info"]].map(([title, glyph, on, color]) =>
      row({ h: 40, gap: 10, name: `extension-${slug(title)}`, label: title },
        badge(color, { glyph, ink: "on-primary", size: 28, radius: "sm" }),
        text(title, { size: "sm", color: "title", grow: 1 }),
        switcher(on, { ref: `extension-${slug(title)}-switch`, label: title }),
        btn("pin", { size: 28, label: `Pin ${title}`, ref: `pin-${slug(title)}` })))), hr(),
    col({ gap: 0 }, ...[["Get extensions", "externalLink", "get-extensions"], ["Manage extensions", "puzzle", "manage-extensions"]].map(([title, glyph, ref]) =>
      ({ ...menuRow(title, { ref, lead: stack({ w: 28, h: 28 }, icon(glyph, { size: 16, color: "soft", place: "center" })) }), pad: 0 })))),
  ],
});

const browserPanel = (title, tools, ...kids) => horizonWindow(AMBER, [startPage()], {
  activeButton: "menu",
  overlays: [popover({ w: 380, pad: 16, gap: 12, place: toolbarPopup("menu", 380), name: `${slug(title)}-panel`, label: title },
    panelTitle(title, ...tools),
    ...kids)],
});

const favoriteLeaf = (title, initial, color, ref) => menuRow(title, {
  ref, h: 36, lead: row({ gap: 10 }, box({ w: 14 }), badge(color, { initial, size: 16, radius: "xs", ink: "site-ink" })),
});
const treeFolder = (title, open) => menuRow(title, { ref: `tree-${slug(title)}`, h: 36,
  lead: icon(open ? "chevronDown" : "chevronRight", { size: 14, color: "soft" }), glyph: open ? "folderOpen" : "folder" });
const treeChildren = (...kids) => row({ pad: [0, 0, 0, 17], align: "stretch" },
  box({ w: 1, fill: "line" }), col({ grow: 1, pad: [0, 0, 0, 10], gap: 0 }, ...kids));

const favoritesPanel = () => browserPanel("Favorites", [
  btn("search", { label: "Search favorites" }), btn("folderPlus", { label: "New folder" }),
], col({ gap: 0 },
  treeFolder("Favorites bar", true),
  treeChildren(
    favoriteLeaf("Rutas del Sur", "R", "site-routes", "tree-routes"),
    treeFolder("Trip", true),
    treeChildren(
      favoriteLeaf("Lago Azul Inn: your booking", "L", "site-inn", "tree-inn"),
      favoriteLeaf("El Chaltén: trails open in April", "E", "site-trails", "tree-trails"),
      favoriteLeaf("Full map of Route 40", "M", "site-map", "tree-map")),
    treeFolder("Recipes", false), treeFolder("Lago Azul Inn", false), treeFolder("Maps", false)),
  treeFolder("Other favorites", false)));

const historyItem = (title, host, time, initial, color) => row({ h: 44, gap: 10 },
  badge(color, { initial, size: 24, radius: "sm", ink: "site-ink" }),
  col({ grow: 1, gap: 2 }, text(title, { size: "sm", color: "title", lines: 1 }), note(host)),
  note(time));
const day = (title, ...items) => col({ gap: 4 }, label(title), ...items);
const history = () => browserPanel("History", [], input("Search history"),
  day("Today",
    historyItem("Route 40: gravel sections and fuel stops", "rutasdelsur.example", "10:42", "R", "site-routes"),
    historyItem("Lago Azul Inn: your booking", "lagoazul.example", "10:18", "L", "site-inn")), hr(),
  day("Yesterday",
    historyItem("El Chaltén: trails open in April", "senderos.example", "18:06", "E", "site-trails"),
    historyItem("Sourdough bread: the complete guide", "masa.example", "09:30", "S", "site-bread")), hr(),
  footAction("Clear browsing data", "trash2", "clear-browsing-data"));

const downloadItem = (name, state, extra) => row({ gap: 10, pad: [8, 0], align: "start" },
  icon("fileText", { size: 24, color: "soft" }),
  col({ grow: 1, gap: 6, pad: [2, 0, 0, 0] }, text(name, { size: "sm", weight: 600, color: "title" }), note(state), extra));
const downloads = () => browserPanel("Downloads", [btn("folderOpen", { label: "Open downloads folder" })],
  downloadItem("Patagonia itinerary.pdf", "Done · 2.4 MB", null), hr(),
  downloadItem("Route 40 offline map.zip", "Downloading · 64 %", progress(0.64, { w: 280, h: 4 })), hr(),
  downloadItem("Lago Azul booking.pdf", "Failed · Connection interrupted", panelAction("Retry", { ghost: true, glyph: "rotateCw", ref: "retry-download" })));

const passwordItem = (site, initial, color) => row({ h: 44, gap: 10 },
  badge(color, { initial, size: 24, radius: "sm", ink: "site-ink" }),
  col({ grow: 1, gap: 2 }, text(site, { size: "sm", weight: 600, color: "title" }), note("ana.ferrer@example.com")),
  btn("copy", { label: `Copy ${site} password` }));
const passwords = () => browserPanel("Passwords", [btn("lock", { label: "Lock passwords" })],
  row({ gap: 10 }, slot(icon("fingerprint", { size: 16, color: "success" })), note("Unlocked with Windows Hello")),
  input("Search passwords"), col({ gap: 0 }, passwordItem("Lago Azul Inn", "L", "site-inn"), passwordItem("Rutas del Sur", "R", "site-routes")), hr(),
  footAction("Add password", "plus", "add-password"));

// ---- Themes inside the Hub -------------------------------------------------

// ---- Desktop: the same project in a panel and in its own tab -----------------

export default board({
  id: "flows", title: "Flows",
  note: "How Horizon is used, from Home on the left: the browser's own tools in the three-dot menu at the top, Horizon's apps in the Hub, and Desktop and Lyra in the side panel. Click a screen and this box explains that step. The sites and the data are invented.",
  screens: [
    { id: "inicio", title: "1. Home", col: 0, row: 5, root: home, note: "Search the web or open a browser tool. Continue the latest Desktop project below the horizon." },
    { id: "menu", title: "2. Browser menu", col: 1, row: 2, root: browserMenu, note: "The browser's own tools live in the three-dot menu. Open a panel or Settings from here." },
    { id: "account", title: "3. Account and profiles", col: 1, row: 5, root: account, note: "Manage the Nebula account and choose a profile. Each profile belongs to its own Space." },
    { id: "extensions", title: "4. Extensions", col: 1, row: 6, root: extensions, note: "Turn installed extensions on or off and pin them. Get more extensions or manage the installed ones." },
    { id: "buscar", title: "5. Search", col: 1, row: 7, root: searching, note: "Suggestions come from history, favorites and Desktop projects. Open the Route 40 article." },
    { id: "settings", title: "6. Settings", col: 2, row: 0, root: settingsGeneral, note: "Choose how Horizon starts, searches and saves downloads. Import favorites and history from Edge." },
    { id: "favorites-panel", title: "7. Favorites", col: 2, row: 1, root: favoritesPanel, note: "Browse favorites as a file tree. Expand folders or create a new one." },
    { id: "history", title: "8. History", col: 2, row: 2, root: history, note: "Find pages visited today or yesterday. Clear browsing data from the panel's foot." },
    { id: "downloads", title: "9. Downloads", col: 2, row: 3, root: downloads, note: "Review completed, running and failed downloads. Open the downloads folder or retry a failed file." },
    { id: "passwords", title: "10. Passwords", col: 2, row: 4, root: passwords, note: "Windows Hello unlocks saved sign-ins. Find, copy or add a password." },
    { id: "private", title: "11. Private window", col: 2, row: 5, root: privateWindow, note: "Browse with the strictest blocking. Nothing from this window is kept after it closes." },
    { id: "extension", title: "12. Get an extension", col: 2, row: 6, root: extension, note: "Before installing an extension, Horizon warns when it needs a feature that is not supported." },
    { id: "sitio", title: "13. Site open", col: 2, row: 7, root: site, note: "The article opens in its tab. Reach the shield, tab groups, Hub, Capture and Lyra from the chrome." },
    { id: "sync", title: "14. Sync settings (Daylight)", col: 3, row: 0, root: sync, note: "Data syncs encrypted through Nebula. Turn off what should stay on this computer." },
    { id: "favorites", title: "15. Favorites folder", col: 3, row: 1, root: favorites, note: "Open a favorite from the Trip folder on the favorites bar. Open all three together when needed." },
    { id: "escudo", title: "16. Site blocking", col: 3, row: 2, root: shield, note: "If the site breaks, turn off blocking with one click. Dark mode and permissions live here too." },
    { id: "grupos", title: "17. Tab groups", col: 3, row: 3, root: groups, note: "Group tabs under a name, colour and icon. Search for an icon or choose a custom colour." },
    { id: "hub", title: "18. Hub", col: 3, row: 4, root: hub, note: "Horizon's six apps live in the Hub. The dock at the top holds Home and pinned quick-access apps. The full flow is on the Hub board." },
    { id: "captura", title: "19. Capture", col: 3, row: 6, root: capture, note: "One press captures the visible page and keeps it locally. The preview card offers Crop, Full page, Copy, Lyra and Save to a project. The full flow is on the Capture board." },
    { id: "lyra-permiso", title: "20. Lyra asks first", col: 3, row: 7, root: lyraPermission, note: "Lyra reads a page only when asked. The first time on each site, she asks for permission. The full flow is on the Lyra board." },
    { id: "vault", title: "21. Vault fills in", col: 4, row: 1, root: vault, note: "Vault suggests the account on the right site. A fingerprint or Windows PIN is required before filling in." },
    { id: "oscuro", title: "22. Dark mode", col: 4, row: 2, root: dark, note: "Read a site in dark mode even when it has no dark theme. The choice is saved per site." },
    { id: "pin", title: "23. Quick access", col: 4, row: 3, root: pin, note: "Right-click Split view in the Hub. Add it beside Capture in the toolbar." },
    { id: "translate", title: "24. Translate", col: 4, row: 4, root: translate, note: "Read a French travel page in English. Show the original whenever needed." },
    { id: "themes", title: "25. Themes", col: 4, row: 5, root: themes, note: "Choose an installed theme or get one from the marketplace inside the Hub. Home returns to the app grid." },
    { id: "desktop-panel", title: "26. Desktop", col: 4, row: 6, root: desktopPanel, note: "The saved capture joins pages, notes and Lyra summaries in the project. Drag material from the page into Desktop or open the project in a tab. The full flow is on the Desktop board." },
    { id: "lyra-resumen", title: "27. Lyra summarises", col: 4, row: 7, root: lyraSummary, note: "Lyra summarises the page locally. Save the result to Desktop. The full flow is on the Lyra board." },
    { id: "split", title: "28. Split view", col: 5, row: 3, root: split, note: "Read two pages side by side. Capture and Split view are now pinned in the toolbar." },
    { id: "desktop", title: "29. Desktop in a tab", col: 5, row: 6.5, root: desktop, note: "Review the project's pages, captures, notes and Lyra summaries together. Work with its folders or reopen it as a tab group. The full flow is on the Desktop board." },
  ],
  links: [
    {"from":"inicio","at":"menu","to":"menu","label":"Menu"},
    {"from":"inicio","at":"avatar","to":"account","label":"Account"},
    {"from":"inicio","at":"extensions","to":"extensions","label":"Extensions"},
    {"from":"inicio","at":"search","to":"buscar","label":"Type"},
    {"from":"menu","at":"menu-settings","to":"settings","label":"Settings"},
    {"from":"menu","at":"menu-favorites","to":"favorites-panel","label":"Favorites"},
    {"from":"menu","at":"menu-history","to":"history","label":"History"},
    {"from":"menu","at":"menu-downloads","to":"downloads","label":"Downloads"},
    {"from":"menu","at":"menu-passwords","to":"passwords","label":"Passwords"},
    {"from":"account","at":"private-window","to":"private","label":"Private"},
    {"from":"extensions","at":"get-extensions","to":"extension","label":"Get"},
    {"from":"buscar","at":"suggestion-2","to":"sitio","label":"Open"},
    {"from":"settings","at":"settings-sync","to":"sync","label":"Sync"},
    {"from":"sitio","at":"favorite-trip","to":"favorites","label":"Folder"},
    {"from":"sitio","at":"shield","to":"escudo","label":"Shield"},
    {"from":"sitio","at":"tabs","to":"grupos","label":"Group"},
    {"from":"sitio","at":"hub","to":"hub","label":"Hub"},
    {"from":"sitio","at":"capture","to":"captura","label":"Capture"},
    {"from":"sitio","at":"lyra","to":"lyra-permiso","label":"Lyra"},
    {"from":"favorites","at":"trip-lago-azul","to":"vault","label":"Open"},
    {"from":"escudo","at":"site-dark-switch","to":"oscuro","label":"Dark mode"},
    {"from":"hub","at":"hub-split-view","to":"pin","label":"Right-click"},
    {"from":"hub","at":"hub-translate","to":"translate","label":"Translate"},
    {"from":"hub","at":"hub-themes","to":"themes","label":"Themes"},
    {"from":"captura","at":"capture-save","to":"desktop-panel","label":"Save"},
    {"from":"lyra-permiso","at":"allow-site","to":"lyra-resumen","label":"Allow"},
    {"from":"pin","at":"add-quick-access","to":"split","label":"Add"},
    {"from":"desktop-panel","at":"panel-open-tab","to":"desktop","label":"Open"},
    {"from":"lyra-resumen","at":"save-desktop","to":"desktop","label":"Save"},
  ],
});
