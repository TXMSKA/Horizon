// Horizon's window as the owner approved it on 2026-10-01: the Familia Nebula
// layout (identity board, variant 3) and its two themes, Amber and Daylight.
// Shared by every board of this repository so a screen is drawn once.

import { box, col, row, stack, text, icon, vector, space, fill } from "blueprint/kit.mjs";
import { badge, btn, dot, hr, vr } from "blueprint/ui.mjs";

export const slug = (value) =>
  String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ---- themes ---------------------------------------------------------------

// The owner's pick, refined with Nova's theme rules (Nova repo, docs/flows/kit/
// skins.mjs and its brainstorm, 2026-10-01): the full role set, text, status
// and accent colours at 4.5:1 on every surface they sit on and frame at 3:1,
// checked with a script. Amber steps its surfaces up from the darkest canvas
// in one warm family. Daylight is drawn by hand rather than inverted: an
// off-white page, chrome a shade darker, white cards and fields, soft
// borders, near-black text and a deeper, quieter coral; the mark keeps a
// brighter coral, since a graphic needs only 3:1.
export const AMBER = {
  canvas: "#030202", surface: "#120e0f", "surface-2": "#1a1416", "surface-3": "#241c1e",
  glass: "rgba(12, 9, 9, 0.9)", hover: "#161112",
  "border-subtle": "#1d1618", line: "#2c2124", "line-strong": "#3f3034", frame: "#8a7478",
  title: "#f6eff0", text: "#ece3e4", soft: "#c4b3b6", dim: "#a8979a",
  primary: "#ffb04a", "primary-hover": "#ffc06e", "on-primary": "#140d05",
  wash: "#2a1d0f", "on-wash": "#ffcf8f", "primary-border": "rgba(255, 176, 74, 0.4)",
  error: "#ff8a8a", "error-wash": "#2a1214", success: "#62e0a2", warning: "#f3c460", info: "#a4b6ff",
  overlay: "rgba(0, 0, 0, 0.72)", shadow: "#000000", "cover-from": "#3f3034", "cover-to": "#0c0909", white: "#f6eff0", none: "none",
  chrome: "#0c0909", page: "#070506", sky: "#070506", ground: "#070506", horizon: "#ffb04a", sun: "#ffb04a",
  field: "#1a1416", "field-line": "#2c2124",
};
export const DAYLIGHT = {
  canvas: "#fbf8f7", surface: "#ffffff", "surface-2": "#ede6e4", "surface-3": "#e8e1df",
  glass: "rgba(245, 240, 238, 0.88)", hover: "#f0eae8",
  "border-subtle": "#ece5e3", line: "#e2d9d7", "line-strong": "#c9bdba", frame: "#85767a",
  title: "#1d1517", text: "#2d2427", soft: "#5f5154", dim: "#66585b",
  primary: "#b23c1b", "primary-hover": "#963217", "on-primary": "#ffffff",
  wash: "#fbe7e0", "on-wash": "#9a3316", "primary-border": "rgba(178, 60, 27, 0.3)",
  error: "#b3313e", "error-wash": "#fbeaec", success: "#1f7148", warning: "#835a00", info: "#2b5cab",
  overlay: "rgba(29, 21, 23, 0.28)", shadow: "#cbbfbc", "cover-from": "#ede6e4", "cover-to": "#ffffff", white: "#ffffff", none: "none",
  chrome: "#f5f0ee", page: "#fbf8f7", sky: "#fbf8f7", ground: "#fbf8f7", horizon: "#cf4824", sun: "#cf4824",
  field: "#ffffff", "field-line": "#e2d9d7",
};

// ---- the mark -------------------------------------------------------------

// A half sun on a line. A vector box twice as wide as tall turns the arc's
// radii (50 by 100 on the grid) into a true half circle.
export const HALF = "M0 100 A50 100 0 0 1 100 100 Z";
export const ARC = "M0 100 A50 100 0 0 1 100 100";

/** The mark: a filled sun, or only its outline, sitting on the horizon. */
export function mark(size, { outline = false, line = "horizon", sun = "primary" } = {}) {
  const h = Math.round(size * 0.62);
  return stack(
    { w: size, h, name: "mark", label: "Marca de Horizon" },
    vector({ d: outline ? ARC : HALF, w: Math.round(size * 0.6), h: Math.round(size * 0.3), fill: outline ? undefined : sun, stroke: outline ? sun : undefined, strokeWidth: 2, place: { x: Math.round(size * 0.2), y: h - Math.round(size * 0.3) - 1 } }),
    box({ w: size, h: 2, radius: "pill", fill: line, place: "bottom-left" }),
  );
}

// ---- the window -----------------------------------------------------------

export const TABS = [
  { title: "Inicio", glyph: "house" },
  { title: "Pan de masa madre: la guía completa", color: "#c9733a", initial: "P" },
  { title: "Rutas por la Patagonia en otoño", color: "#3a7bc9", initial: "R" },
];

export function tabLead(tab, on) {
  return tab.glyph
    ? icon(tab.glyph, { size: 14, color: on ? "primary" : "soft" })
    : badge(tab.color, { initial: tab.initial, size: 16, radius: 4 });
}

export function profile() {
  return row(
    { h: 30, pad: [0, 10], gap: 8, radius: "md", fill: "surface-2", name: "profile", label: "Perfil: Personal" },
    dot("primary", 8),
    text("Personal", { size: "xs", weight: 600, color: "title" }),
    icon("chevronDown", { size: 12, color: "soft" }),
  );
}

export function windowControls() {
  return row(
    { h: 44, name: "window-controls", label: "Minimizar, maximizar y cerrar" },
    ...["minus", "square", "x"].map((glyph) => stack({ w: 46, h: 44 }, icon(glyph, { size: glyph === "square" ? 12 : 15, color: "soft", place: "center" }))),
  );
}

export function tabStrip({ tabs = TABS, active = 0 } = {}) {
  return row(
    { h: 44, pad: [0, 0, 0, 10], gap: 6, fill: "chrome", name: "tabs", label: "Pestañas" },
    profile(),
    vr(20),
    ...tabs.map((tab, i) => {
      const on = i === active;
      return row(
        { w: 224, h: 32, pad: [0, 8, 0, 10], gap: 8, radius: "md", fill: on ? "page" : undefined, name: `tab-${slug(tab.title)}`, label: tab.title },
        tabLead(tab, on),
        text(tab.title, { size: "xs", weight: on ? 600 : 500, color: on ? "title" : "soft", lines: 1, grow: 1 }),
        icon("x", { size: 13, color: "dim" }),
      );
    }),
    btn("plus", { size: 28, g: 16, label: "Nueva pestaña" }),
    fill(),
    windowControls(),
  );
}

/**
 * The address bar: the placeholder, or a typed `value` with the caret when
 * `focus` is set; `blocked` is the count beside the shield (none on Horizon's own pages), `starred` fills
 * the star.
 */
export function address({ value, focus = false, blocked = 14, starred = false } = {}) {
  return row(
    { grow: 1, h: 36, pad: [0, 14], gap: 10, radius: "pill", fill: "surface-2", stroke: focus ? "primary" : undefined, strokeWidth: 1.5, name: "address", label: "Barra de direcciones" },
    stack({ w: 16, h: 16, name: "shield", label: "Bloqueo de este sitio" }, icon("shieldCheck", { size: 16, color: "primary" })),
    row(
      { gap: 1 },
      text(value ?? "Buscá o escribí una dirección", { size: "sm", color: value ? "title" : "dim" }),
      focus ? box({ w: 1.5, h: 18, fill: "primary" }) : null,
    ),
    fill(),
    blocked == null ? null : text(`${blocked} bloqueados`, { size: "xs", color: "soft" }),
    icon("star", { size: 16, color: starred ? "primary" : "soft", filled: starred }),
  );
}

export function toolbar({ controls = false, bar } = {}) {
  return row(
    { h: 52, pad: [0, controls ? 0 : 12, 0, 12], gap: 4, fill: "chrome", edge: { side: "bottom", color: "line" }, name: "toolbar", label: "Barra de herramientas" },
    btn("arrowLeft", { label: "Atrás" }),
    btn("arrowRight", { label: "Adelante", tone: "dim" }),
    btn("rotateCw", { label: "Recargar" }),
    space(6),
    address(bar),
    space(6),
    btn("notebookPen", { label: "Notebooks" }),
    btn("sparkles", { label: "Lyra", tone: "primary" }),
    btn("ellipsis", { label: "Menú" }),
    controls ? space(6) : null,
    controls ? windowControls() : null,
  );
}

/** Vertical tabs, for the Nebula variant that keeps its tabs in a side bar. */
function sideTabs() {
  const tabRow = (tab, i) => {
    const on = i === 0;
    return row(
      { h: 34, pad: [0, 10], gap: 10, radius: "md", fill: on ? "surface-2" : undefined, name: `tab-${slug(tab.title)}`, label: tab.title },
      tabLead(tab, on),
      text(tab.title, { size: "sm", weight: on ? 600 : 400, color: on ? "title" : "soft", lines: 1, grow: 1 }),
    );
  };
  const notebook = (title, on = false) =>
    row(
      { h: 32, pad: [0, 10], gap: 10, radius: "md", name: `notebook-${slug(title)}`, label: title },
      icon("notebookPen", { size: 14, color: on ? "primary" : "soft" }),
      text(title, { size: "sm", color: on ? "title" : "soft", lines: 1 }),
    );
  return col(
    { w: 252, pad: [10, 10], gap: 4, fill: "chrome", edge: { side: "right", color: "line" }, name: "side-tabs", label: "Pestañas verticales" },
    profile(),
    space(10),
    ...TABS.map(tabRow),
    row(
      { h: 34, pad: [0, 10], gap: 10, radius: "md", name: "new-tab", label: "Nueva pestaña" },
      icon("plus", { size: 14, color: "soft" }),
      text("Nueva pestaña", { size: "sm", color: "soft" }),
    ),
    space(18),
    hr(),
    space(10),
    notebook("Viaje a la Patagonia", true),
    notebook("Cocina de fin de semana"),
    notebook("Comparar notebooks livianas"),
  );
}

/**
 * The standalone window, painted with one theme. `tabs` and `active` set the
 * tab strip, `bar` the address bar, `side` a panel docked on the right of the
 * page, and `overlays` popovers placed over the whole window.
 */
export function horizonWindow(theme, page, { vertical = false, tabs, active, bar, side, overlays, label = "Página de inicio" } = {}) {
  const content = stack({ grow: 1, clip: true, fill: "page", name: "start-page", label }, ...page);
  const body = side ? row({ grow: 1, align: "stretch" }, content, side) : content;
  if (vertical) {
    return row(
      { h: 900, fill: "page", align: "stretch", theme, name: "window", label: "Ventana de Horizon" },
      sideTabs(),
      col({ grow: 1 }, toolbar({ controls: true, bar }), body),
    );
  }
  const frame = col({ h: 900, fill: "page", theme: overlays ? undefined : theme, name: "window", label: "Ventana de Horizon" }, tabStrip({ tabs, active }), toolbar({ bar }), body);
  return overlays ? stack({ h: 900, theme }, frame, ...overlays) : frame;
}

// ---- start-page pieces ----------------------------------------------------

export function search({ w = 640, h = 52, radius = "pill", face = "body", stroke = "field-line" } = {}) {
  return row(
    { w, h, pad: [0, 18], gap: 12, radius, fill: "field", stroke, name: "search", label: "Buscar" },
    icon("search", { size: 18, color: "soft" }),
    text("Buscá en la web o escribí una dirección", { size: "base", color: "dim", face }),
    fill(),
    icon("sparkles", { size: 18, color: "primary" }),
  );
}

export function resume({ face = "body", size = "sm" } = {}) {
  return col(
    { gap: 4, name: "resume", label: "Seguir investigando" },
    row({ gap: 8 }, icon("notebookPen", { size: 16, color: "primary" }), text("Seguir con Viaje a la Patagonia", { size, weight: 600, color: "title", face })),
    text("6 notas y 3 capturas, ayer a la noche", { size: "xs", color: "soft" }),
  );
}

export function lyra({ face = "body" } = {}) {
  return row(
    { gap: 8, name: "lyra", label: "Preguntarle a Lyra" },
    icon("sparkles", { size: 16, color: "primary" }),
    text("Preguntale a Lyra por lo que tenés abierto", { size: "sm", color: "text", face }),
  );
}

export const SITES = ["Wikipedia", "YouTube", "Mapas", "Noticias", "Correo"];

export function shortcuts({ gap = 24, face = "body", vertical = false } = {}) {
  const items = SITES.map((site) => text(site, { size: "sm", color: "soft", face, name: `shortcut-${slug(site)}`, label: site }));
  return vertical ? col({ gap: 10, name: "shortcuts", label: "Atajos" }, ...items) : row({ gap, name: "shortcuts", label: "Atajos" }, ...items);
}

export const NOTES = [
  { title: "Ruta 40: tramos de ripio y dónde cargar nafta", source: "rutasdelsur.example" },
  { title: "El Chaltén en abril: senderos abiertos", source: "captura de pantalla" },
  { title: "Presupuesto: alojamiento y auto", source: "nota propia" },
];

export function noteRow(note, { face = "body", mono = "mono", source = true } = {}) {
  return row(
    { h: 50, gap: 12, edge: { side: "bottom", color: "line" }, name: `note-${slug(note.title)}`, label: note.title },
    icon(note.source === "captura de pantalla" ? "camera" : "fileText", { size: 16, color: "soft" }),
    text(note.title, { size: "sm", color: "title", face, lines: 1, grow: 1 }),
    source ? text(note.source, { size: "xs", color: "dim", face: mono, lines: 1 }) : null,
  );
}

// ---- the start page -------------------------------------------------------

/** The approved start page: the mark, the search, the shortcuts and the notebook to resume. */
export function startPage() {
  return col(
    { w: 760, gap: 20, place: { x: 340, y: 130 } },
    row({ gap: 16, justify: "center" }, mark(52), text("Horizon", { size: 44, weight: 650, color: "title" })),
    space(10),
    search({ w: 760, radius: "lg" }),
    row({ gap: 24, justify: "center" }, ...SITES.map((site) => text(site, { size: "sm", color: "soft", name: `shortcut-${slug(site)}`, label: site }))),
    space(30),
    col(
      { pad: 24, gap: 6, radius: "lg", fill: "surface", stroke: "line" },
      row({ gap: 10 }, resume(), fill(), text("Abrir notebook", { size: "sm", weight: 600, color: "primary", name: "open-notebook", label: "Abrir notebook" })),
      space(6),
      ...NOTES.map((note) => noteRow(note)),
    ),
    space(6),
    lyra(),
  );
}
