// Horizon's visual identity, three directions with three variants each, asked
// for by the owner on 2026-10-01 in the brainstorm: Amanecer (warm dawn colours),
// Linea de horizonte (one clean line as the gesture, sober colours) and
// Familia Nebula (Nebula's surfaces with a colour of Horizon's own).
//
// Every variant draws the same thing, the standalone window on its start page,
// so only the identity changes from one to the next: tabs with the profile,
// the address bar with what was blocked, Notebooks and Lyra in the toolbar,
// the search, the notebook to resume and the shortcuts. The data is invented.
// Rows are directions, columns are variants.

import { board } from "blueprint/board.mjs";
import { box, col, row, stack, text, icon, vector, space, fill } from "blueprint/kit.mjs";
import { badge, btn, dot, hr, vr } from "blueprint/ui.mjs";

const slug = (value) =>
  String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ---- palettes -------------------------------------------------------------

// Every theme names the same roles: the kit's controls read the usual ones,
// and the start pages read chrome, page, sky, ground, horizon, sun, field and
// field-line.
const T = {
  a1: {
    canvas: "#fff8f2", surface: "#ffffff", "surface-2": "#f8ece2", "surface-3": "#f1dfd2", hover: "#fbf1e9",
    "border-subtle": "#f0e1d5", line: "#e8d3c3", "line-strong": "#d4b8a5",
    title: "#3b2420", text: "#4b332c", soft: "#85665b", dim: "#9c7f73",
    primary: "#d9502f", "on-primary": "#ffffff", wash: "#fbe3d8",
    chrome: "#fff1e7", page: "#fff8f2", sky: "url(#rv-hz-a1-sky)", ground: "#fff8f2", horizon: "#e6c2aa", sun: "#ee6a43",
    field: "#ffffff", "field-line": "#e8d3c3",
  },
  a2: {
    canvas: "#15121f", surface: "#1e1a2b", "surface-2": "#262033", "surface-3": "#302940", hover: "#211c2e",
    "border-subtle": "#2a2438", line: "#3a3150", "line-strong": "#54496b",
    title: "#fff2e4", text: "#f1e1d1", soft: "#c3ae9f", dim: "#9a8a84",
    primary: "#f4a649", "on-primary": "#1b1526", wash: "rgba(244, 166, 73, 0.14)",
    chrome: "#15121f", page: "#1b1830", sky: "url(#rv-hz-a2-sky)", ground: "#120f1b", horizon: "#f4a649", sun: "#f7b05b",
    field: "rgba(255, 244, 230, 0.08)", "field-line": "rgba(255, 244, 230, 0.24)",
  },
  a3: {
    canvas: "#faf7f3", surface: "#ffffff", "surface-2": "#f3eee8", "surface-3": "#eae3db", hover: "#f6f2ed",
    "border-subtle": "#eee7df", line: "#e3dad0", "line-strong": "#cbbfb2",
    title: "#2d2420", text: "#3e332d", soft: "#7a6a60", dim: "#978880",
    primary: "#db7334", "on-primary": "#ffffff", wash: "#fbe6d6",
    chrome: "#f5f1ec", page: "#faf7f3", sky: "#faf7f3", ground: "#faf7f3", horizon: "#ebcdb5", sun: "url(#rv-hz-a3-sun)",
    field: "#ffffff", "field-line": "#e3dad0",
  },
  b1: {
    canvas: "#ffffff", surface: "#ffffff", "surface-2": "#f4f4f4", "surface-3": "#e9e9e9", hover: "#f7f7f7",
    "border-subtle": "#eeeeee", line: "#e2e2e2", "line-strong": "#bdbdbd",
    title: "#111111", text: "#2b2b2b", soft: "#666666", dim: "#8a8a8a",
    primary: "#2348f5", "on-primary": "#ffffff", wash: "#e9edff",
    chrome: "#ffffff", page: "#ffffff", sky: "#ffffff", ground: "#ffffff", horizon: "#111111", sun: "#2348f5",
    field: "#ffffff", "field-line": "#e2e2e2",
  },
  b2: {
    canvas: "#0c0f13", surface: "#161b21", "surface-2": "#1b2128", "surface-3": "#242b33", hover: "#181d23",
    "border-subtle": "#1e242b", line: "#2a323b", "line-strong": "#3e4853",
    title: "#e9eff3", text: "#c9d3da", soft: "#93a0aa", dim: "#6f7c86",
    primary: "#7fd1c7", "on-primary": "#0c0f13", wash: "rgba(127, 209, 199, 0.12)",
    chrome: "#101317", page: "#14181e", sky: "#14181e", ground: "#0e1115", horizon: "#7fd1c7", sun: "#7fd1c7",
    field: "#1b2128", "field-line": "#2a323b",
  },
  b3: {
    canvas: "#f3eee5", surface: "#faf6ef", "surface-2": "#eae3d7", "surface-3": "#dfd6c8", hover: "#efe8dd",
    "border-subtle": "#e3dacd", line: "#d6cbbb", "line-strong": "#b5a894",
    title: "#2a2521", text: "#3a332d", soft: "#6f655b", dim: "#8c8175",
    primary: "#b4502c", "on-primary": "#ffffff", wash: "#f1dcd0",
    chrome: "#ece5d9", page: "#f3eee5", sky: "#f3eee5", ground: "#f3eee5", horizon: "#b4502c", sun: "#b4502c",
    field: "#faf6ef", "field-line": "#2a2521",
  },
};

// Nebula's official theme (Nebula repo, docs/flows/kit/skins.mjs, approved
// 2026-09-29), with Horizon's own colour in place of Nebula's crimson.
const NEBULA = {
  canvas: "#020102", surface: "#0a0708", "surface-2": "#171113", "surface-3": "#21191b", hover: "#110c0d",
  "border-subtle": "#1a1315", line: "#2a1e21", "line-strong": "#3d2b2f",
  title: "#f7f0f1", text: "#f7f0f1", soft: "#c4b0b3", dim: "#a38f92",
  "on-primary": "#0a0708",
  chrome: "#0a0708", page: "#050304", sky: "#050304", ground: "#050304",
  field: "#171113", "field-line": "#2a1e21",
};
T.c1 = { ...NEBULA, primary: "#ffab3d", wash: "rgba(255, 171, 61, 0.12)", horizon: "#ffab3d", sun: "#ffab3d" };
T.c2 = { ...NEBULA, primary: "#5cc8ff", wash: "rgba(92, 200, 255, 0.12)", horizon: "#5cc8ff", sun: "#5cc8ff" };
T.c3 = {
  canvas: "#fbf7f7", surface: "#ffffff", "surface-2": "#f4eded", "surface-3": "#eadfe0", hover: "#f7f1f1",
  "border-subtle": "#efe6e6", line: "#e3d7d8", "line-strong": "#c7b6b8",
  title: "#1a1214", text: "#2e2326", soft: "#6e5c60", dim: "#8c797c",
  primary: "#e24a24", "on-primary": "#ffffff", wash: "#fde4dc",
  chrome: "#f6f0f0", page: "#fbf7f7", sky: "#fbf7f7", ground: "#fbf7f7", horizon: "#e24a24", sun: "#e24a24",
  field: "#ffffff", "field-line": "#e3d7d8",
};

// The owner's pick, refined with Nova's theme rules (Nova repo, docs/flows/kit/
// skins.mjs and its brainstorm, 2026-10-01): the full role set, text, status
// and accent colours at 4.5:1 on every surface they sit on and frame at 3:1,
// checked with a script. Amber steps its surfaces up from the darkest canvas
// in one warm family. Daylight is drawn by hand rather than inverted: an
// off-white page, chrome a shade darker, white cards and fields, soft
// borders, near-black text and a deeper, quieter coral; the mark keeps a
// brighter coral, since a graphic needs only 3:1.
const AMBER = {
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
const DAYLIGHT = {
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
const HALF = "M0 100 A50 100 0 0 1 100 100 Z";
const ARC = "M0 100 A50 100 0 0 1 100 100";

/** The mark: a filled sun, or only its outline, sitting on the horizon. */
function mark(size, { outline = false, line = "horizon", sun = "primary" } = {}) {
  const h = Math.round(size * 0.62);
  return stack(
    { w: size, h, name: "mark", label: "Marca de Horizon" },
    vector({ d: outline ? ARC : HALF, w: Math.round(size * 0.6), h: Math.round(size * 0.3), fill: outline ? undefined : sun, stroke: outline ? sun : undefined, strokeWidth: 2, place: { x: Math.round(size * 0.2), y: h - Math.round(size * 0.3) - 1 } }),
    box({ w: size, h: 2, radius: "pill", fill: line, place: "bottom-left" }),
  );
}

// ---- the window -----------------------------------------------------------

const TABS = [
  { title: "Inicio", glyph: "house" },
  { title: "Pan de masa madre: la guía completa", color: "#c9733a", initial: "P" },
  { title: "Rutas por la Patagonia en otoño", color: "#3a7bc9", initial: "R" },
];

function tabLead(tab, on) {
  return tab.glyph
    ? icon(tab.glyph, { size: 14, color: on ? "primary" : "soft" })
    : badge(tab.color, { initial: tab.initial, size: 16, radius: 4 });
}

function profile() {
  return row(
    { h: 30, pad: [0, 10], gap: 8, radius: "md", fill: "surface-2", name: "profile", label: "Perfil: Personal" },
    dot("primary", 8),
    text("Personal", { size: "xs", weight: 600, color: "title" }),
    icon("chevronDown", { size: 12, color: "soft" }),
  );
}

function windowControls() {
  return row(
    { h: 44, name: "window-controls", label: "Minimizar, maximizar y cerrar" },
    ...["minus", "square", "x"].map((glyph) => stack({ w: 46, h: 44 }, icon(glyph, { size: glyph === "square" ? 12 : 15, color: "soft", place: "center" }))),
  );
}

function tabStrip() {
  return row(
    { h: 44, pad: [0, 0, 0, 10], gap: 6, fill: "chrome", name: "tabs", label: "Pestañas" },
    profile(),
    vr(20),
    ...TABS.map((tab, i) => {
      const on = i === 0;
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

function address() {
  return row(
    { grow: 1, h: 36, pad: [0, 14], gap: 10, radius: "pill", fill: "surface-2", name: "address", label: "Barra de direcciones" },
    icon("shieldCheck", { size: 16, color: "primary" }),
    text("Buscá o escribí una dirección", { size: "sm", color: "dim" }),
    fill(),
    text("14 bloqueados", { size: "xs", color: "soft" }),
    icon("star", { size: 16, color: "soft" }),
  );
}

function toolbar({ controls = false } = {}) {
  return row(
    { h: 52, pad: [0, controls ? 0 : 12, 0, 12], gap: 4, fill: "chrome", edge: { side: "bottom", color: "line" }, name: "toolbar", label: "Barra de herramientas" },
    btn("arrowLeft", { label: "Atrás" }),
    btn("arrowRight", { label: "Adelante", tone: "dim" }),
    btn("rotateCw", { label: "Recargar" }),
    space(6),
    address(),
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

/** The standalone window, painted with one variant's theme. */
function horizonWindow(theme, page, { vertical = false } = {}) {
  const content = stack({ grow: 1, clip: true, fill: "page", name: "start-page", label: "Página de inicio" }, ...page);
  if (vertical) {
    return row(
      { h: 900, fill: "page", align: "stretch", theme, name: "window", label: "Ventana de Horizon" },
      sideTabs(),
      col({ grow: 1 }, toolbar({ controls: true }), content),
    );
  }
  return col({ h: 900, fill: "page", theme, name: "window", label: "Ventana de Horizon" }, tabStrip(), toolbar(), content);
}

// ---- start-page pieces ----------------------------------------------------

function search({ w = 640, h = 52, radius = "pill", face = "body", stroke = "field-line" } = {}) {
  return row(
    { w, h, pad: [0, 18], gap: 12, radius, fill: "field", stroke, name: "search", label: "Buscar" },
    icon("search", { size: 18, color: "soft" }),
    text("Buscá en la web o escribí una dirección", { size: "base", color: "dim", face }),
    fill(),
    icon("sparkles", { size: 18, color: "primary" }),
  );
}

function resume({ face = "body", size = "sm" } = {}) {
  return col(
    { gap: 4, name: "resume", label: "Seguir investigando" },
    row({ gap: 8 }, icon("notebookPen", { size: 16, color: "primary" }), text("Seguir con Viaje a la Patagonia", { size, weight: 600, color: "title", face })),
    text("6 notas y 3 capturas, ayer a la noche", { size: "xs", color: "soft" }),
  );
}

function lyra({ face = "body" } = {}) {
  return row(
    { gap: 8, name: "lyra", label: "Preguntarle a Lyra" },
    icon("sparkles", { size: 16, color: "primary" }),
    text("Preguntale a Lyra por lo que tenés abierto", { size: "sm", color: "text", face }),
  );
}

const SITES = ["Wikipedia", "YouTube", "Mapas", "Noticias", "Correo"];

function shortcuts({ gap = 24, face = "body", vertical = false } = {}) {
  const items = SITES.map((site) => text(site, { size: "sm", color: "soft", face, name: `shortcut-${slug(site)}`, label: site }));
  return vertical ? col({ gap: 10, name: "shortcuts", label: "Atajos" }, ...items) : row({ gap, name: "shortcuts", label: "Atajos" }, ...items);
}

const NOTES = [
  { title: "Ruta 40: tramos de ripio y dónde cargar nafta", source: "rutasdelsur.example" },
  { title: "El Chaltén en abril: senderos abiertos", source: "captura de pantalla" },
  { title: "Presupuesto: alojamiento y auto", source: "nota propia" },
];

function noteRow(note, { face = "body", mono = "mono", source = true } = {}) {
  return row(
    { h: 50, gap: 12, edge: { side: "bottom", color: "line" }, name: `note-${slug(note.title)}`, label: note.title },
    icon(note.source === "captura de pantalla" ? "camera" : "fileText", { size: 16, color: "soft" }),
    text(note.title, { size: "sm", color: "title", face, lines: 1, grow: 1 }),
    source ? text(note.source, { size: "xs", color: "dim", face: mono, lines: 1 }) : null,
  );
}

// ---- Amanecer -------------------------------------------------------------

/** Alba: a peach sky down to the horizon and the sun half risen behind it. */
const alba = () =>
  horizonWindow(T.a1, [
    box({ w: 1440, h: 470, fill: "sky", place: { x: 0, y: 0 } }),
    vector({ d: HALF, w: 240, h: 120, fill: "sun", place: { x: 600, y: 350 } }),
    box({ w: 1440, h: 1, fill: "horizon", place: { x: 0, y: 470 } }),
    col(
      { w: 640, gap: 28, align: "center", place: { x: 400, y: 116 } },
      text("Horizon", { face: "serif", size: 60, color: "title", align: "center" }),
      search(),
    ),
    col(
      { w: 640, gap: 22, align: "center", place: { x: 400, y: 520 } },
      resume({ face: "serif", size: "base" }),
      lyra(),
      space(10),
      shortcuts(),
    ),
  ]);

/** Hora dorada: the whole page is the sky before sunrise, the start sits on the ground. */
const horaDorada = () =>
  horizonWindow(T.a2, [
    box({ w: 1440, h: 600, fill: "sky", place: { x: 0, y: 0 } }),
    vector({ d: HALF, w: 520, h: 260, fill: "sun", place: { x: 460, y: 340 } }),
    box({ w: 1440, h: 204, fill: "ground", place: { x: 0, y: 600 } }),
    col(
      { w: 700, gap: 16, place: { x: 120, y: 104 } },
      text("Buen día", { face: "serif", size: 52, color: "title" }),
      text("Hoy Horizon frenó 214 rastreadores.", { size: "sm", color: "soft" }),
      space(14),
      search(),
    ),
    row(
      { w: 1200, gap: 72, place: { x: 120, y: 664 } },
      resume({ face: "serif", size: "base" }),
      lyra(),
      fill(),
      shortcuts(),
    ),
  ]);

/** Primera luz: a pale page with a wide sun rising from the bottom edge. */
const primeraLuz = () =>
  horizonWindow(T.a3, [
    vector({ d: HALF, w: 1100, h: 550, fill: "sun", place: { x: 170, y: 400 } }),
    col(
      { w: 700, gap: 24, align: "center", place: { x: 370, y: 104 } },
      mark(56),
      text("Horizon", { face: "display", size: 64, weight: 300, color: "title", align: "center" }),
      space(4),
      search(),
    ),
    col(
      { w: 600, gap: 16, align: "center", place: { x: 420, y: 560 } },
      resume({ size: "base" }),
      lyra(),
      space(8),
      shortcuts(),
    ),
  ]);

// ---- Linea de horizonte ---------------------------------------------------

/** Cota: one black line across the page is the address field's underline. */
const cota = () =>
  horizonWindow(T.b1, [
    row(
      { gap: 12, place: { x: 120, y: 72 } },
      mark(28, { line: "title" }),
      text("Horizon", { face: "bahn", size: 18, weight: 600, color: "title" }),
    ),
    box({ w: 2, h: 46, fill: "primary", place: { x: 120, y: 404 } }),
    text("Buscá en la web o escribí una dirección", { face: "bahn", size: 40, weight: 300, color: "dim", place: { x: 134, y: 400 } }),
    box({ w: 1440, h: 1, fill: "horizon", place: { x: 0, y: 470 } }),
    row(
      { w: 1200, gap: 96, align: "start", place: { x: 120, y: 520 } },
      resume({ face: "bahn", size: "base" }),
      lyra({ face: "bahn" }),
      fill(),
      shortcuts({ face: "bahn" }),
    ),
    text("14 rastreadores bloqueados en esta pestaña", { face: "mono", size: "xs", color: "dim", place: { x: 120, y: 740 } }),
  ]);

/** Noche clara: sky above the line for browsing, ground below it for research. */
const nocheClara = () =>
  horizonWindow(T.b2, [
    box({ w: 1440, h: 420, fill: "sky", place: { x: 0, y: 0 } }),
    box({ w: 1440, h: 384, fill: "ground", place: { x: 0, y: 420 } }),
    box({ w: 1440, h: 1, fill: "horizon", place: { x: 0, y: 420 } }),
    vector({ d: ARC, w: 64, h: 32, stroke: "horizon", strokeWidth: 1.5, place: { x: 688, y: 388 } }),
    col(
      { w: 700, gap: 24, align: "center", place: { x: 370, y: 150 } },
      text("Horizon", { face: "display", size: 30, weight: 600, color: "title", track: 0.04 }),
      search({ w: 700 }),
    ),
    col(
      { w: 700, gap: 0, place: { x: 370, y: 470 } },
      row({ h: 36, gap: 10 }, icon("notebookPen", { size: 16, color: "primary" }), text("Viaje a la Patagonia", { size: "base", weight: 600, color: "title" }), fill(), text("6 notas, ayer", { size: "xs", color: "soft" })),
      ...NOTES.map((note) => noteRow(note)),
      space(22),
      lyra(),
    ),
  ]);

/** Papel: a terracotta rule with marks, like a ruler laid on paper. */
const ticks = Array.from({ length: 37 }, (_, i) => `M${((i * 100) / 36).toFixed(3)} 0 V100`).join(" ");
const papel = () =>
  horizonWindow(T.b3, [
    col(
      { w: 560, gap: 8, place: { x: 120, y: 190 } },
      text("Horizon", { face: "serif", size: 76, color: "title" }),
      text("perfil personal, 14 bloqueados", { face: "mono", size: "xs", color: "soft" }),
    ),
    stack({ w: 560, place: { x: 760, y: 300 } }, search({ w: 560, radius: "xs", face: "serif" })),
    vector({ d: ticks, w: 1440, h: 10, stroke: "horizon", strokeWidth: 1, place: { x: 0, y: 420 } }),
    box({ w: 1440, h: 2, fill: "horizon", place: { x: 0, y: 430 } }),
    row(
      { w: 1200, gap: 80, align: "start", place: { x: 120, y: 486 } },
      col(
        { w: 560, pad: 24, gap: 6, radius: "xs", fill: "surface", stroke: "title", name: "resume", label: "Seguir investigando" },
        text("Viaje a la Patagonia", { face: "serif", size: 26, color: "title" }),
        text("6 notas y 3 capturas, ayer a la noche", { face: "mono", size: "xs", color: "soft" }),
        space(8),
        ...NOTES.slice(0, 2).map((note) => noteRow(note, { face: "serif" })),
      ),
      col({ gap: 26 }, lyra({ face: "serif" }), shortcuts({ face: "serif", vertical: true })),
    ),
  ]);

// ---- Familia Nebula -------------------------------------------------------

function panel(...kids) {
  return col({ grow: 1, pad: 22, gap: 14, radius: "lg", fill: "surface", stroke: "border-subtle" }, ...kids);
}

/** Ambar: Nebula's dark window, Horizon's amber in place of the crimson. */
const ambar = () =>
  horizonWindow(T.c1, [
    col(
      { w: 720, gap: 22, align: "center", place: { x: 360, y: 96 } },
      mark(64, { outline: true }),
      text("Horizon", { size: 40, weight: 650, color: "title" }),
      space(6),
      search({ w: 720, radius: "lg" }),
      space(10),
      row(
        { w: 720, gap: 16, align: "stretch" },
        panel(resume(), ...NOTES.slice(0, 2).map((note) => noteRow(note, { source: false }))),
        panel(lyra(), text("Lee la página solo cuando se lo pedís, y corre en tu máquina.", { size: "xs", color: "soft" }), fill(), shortcuts({ gap: 16 })),
      ),
    ),
  ]);

/** Cielo: the same family with a sky blue, and the tabs in a side bar. */
const cielo = () =>
  horizonWindow(
    T.c2,
    [
      col(
        { w: 760, gap: 18, place: { x: 120, y: 120 } },
        row({ gap: 14 }, mark(40, { outline: true }), text("Horizon", { size: 22, weight: 650, color: "title" })),
        space(30),
        text("¿Qué buscamos hoy?", { size: 40, weight: 650, color: "title" }),
        space(6),
        search({ w: 760, radius: "lg" }),
        space(28),
        resume(),
        ...NOTES.map((note) => noteRow(note)),
        space(18),
        lyra(),
      ),
    ],
    { vertical: true },
  );

/** Claro: the family in light, with a coral that keeps Nebula's warmth. */
const claro = (theme = T.c3) =>
  horizonWindow(theme, [
    col(
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
    ),
  ]);

export default board({
  id: "identity",
  title: "Identidad visual",
  note: "Tres direcciones, tres variantes cada una. Filas: Amanecer, Línea de horizonte y Familia Nebula. La última fila es lo elegido: el diseño de Claro con los temas Amber y Daylight. Todas dibujan la misma ventana en su página de inicio, así lo único que cambia es la identidad. Los datos son inventados.",
  screens: [
    { id: "amanecer-alba", title: "Amanecer 1: Alba", col: 0, row: 0, root: alba },
    { id: "amanecer-hora-dorada", title: "Amanecer 2: Hora dorada", col: 1, row: 0, root: horaDorada },
    { id: "amanecer-primera-luz", title: "Amanecer 3: Primera luz", col: 2, row: 0, root: primeraLuz },
    { id: "linea-cota", title: "Línea 1: Cota", col: 0, row: 1, root: cota },
    { id: "linea-noche-clara", title: "Línea 2: Noche clara", col: 1, row: 1, root: nocheClara },
    { id: "linea-papel", title: "Línea 3: Papel", col: 2, row: 1, root: papel },
    { id: "nebula-ambar", title: "Familia Nebula 1: Ámbar", col: 0, row: 2, root: ambar },
    { id: "nebula-cielo", title: "Familia Nebula 2: Cielo", col: 1, row: 2, root: cielo },
    { id: "nebula-claro", title: "Familia Nebula 3: Claro", col: 2, row: 2, root: () => claro() },
    // The owner's pick, 2026-10-01: Claro's layout in the Amber and Daylight themes.
    { id: "elegido-amber", title: "Elegido: Amber (oscuro)", col: 0, row: 3, root: () => claro(AMBER) },
    { id: "elegido-daylight", title: "Elegido: Daylight (claro)", col: 1, row: 3, root: () => claro(DAYLIGHT) },
  ],
});
