// Horizon's flows, asked for by the owner on 2026-10-01 to review the plan: how the
// browser is used, step by step, in the approved window (identity board,
// Familia Nebula, Amber; the sync screen wears Daylight). Each screen carries
// a short note the viewer shows when the screen is clicked. Rows follow
// the plan: browsing and privacy, profiles, research with Lyra and notebooks,
// then passwords, extensions and sync. The sites and the data are invented.

import { board } from "blueprint/board.mjs";
import { box, col, row, stack, text, icon, space, fill } from "blueprint/kit.mjs";
import { action, badge, dot, hr, label, popover, seg, switcher } from "blueprint/ui.mjs";
import { AMBER, DAYLIGHT, NOTES, horizonWindow, mark, noteRow, slug, startPage } from "../kit/horizon.mjs";

// ---- invented sites ---------------------------------------------------------

const SITE_TABS = [
  { title: "Inicio", glyph: "house" },
  { title: "Ruta 40: tramos de ripio y dónde cargar nafta", color: "#2f6b4f", initial: "R" },
  { title: "Pan de masa madre: la guía completa", color: "#c9733a", initial: "P" },
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
    { w: width, h: 804, fill: p.bg, place: { x: 0, y: 0 }, name: "site", label: "Sitio: Rutas del Sur" },
    row(
      { h: 64, pad: [0, side], gap: 28, fill: p.card },
      text("Rutas del Sur", { face: "serif", size: 22, weight: 700, color: p.ink }),
      fill(),
      ...["Rutas", "Clima", "Mapas", "Suscribite"].map((item) => text(item, { size: "sm", color: p.soft })),
    ),
    col(
      { pad: [40, side, 0, side], gap: 14 },
      text("Patagonia", { size: "xs", weight: 700, color: p.accent, upper: true, track: 0.08 }),
      text("Ruta 40: tramos de ripio y dónde cargar nafta", { face: "serif", size: 38, color: p.ink, lh: 1.2 }),
      text("Por Lucía Ferrer. 12 minutos de lectura.", { size: "sm", color: p.soft }),
      space(6),
      box({ h: 230, radius: 12, fill: p.img, name: "site-photo", label: "Foto del artículo" }),
      space(6),
      text("Entre El Calafate y Perito Moreno quedan tres tramos de ripio. El más largo tiene unos 70 kilómetros y conviene hacerlo de día, con las ruedas en buen estado.", { size: "base", color: p.ink }),
      text("Entre dos estaciones de servicio puede haber más de 200 kilómetros: cargá en cada pueblo aunque el tanque no esté vacío.", { size: "base", color: p.ink }),
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
    { w: 400, pad: 20, gap: 16, fill: "surface", edge: { side: "left", color: "line" }, name: "lyra-panel", label: "Panel de Lyra" },
    row(
      { gap: 10 },
      icon("sparkles", { size: 18, color: "primary" }),
      text("Lyra", { size: "base", weight: 650, color: "title" }),
      fill(),
      text("Modelo local", { size: "xs", color: "soft" }),
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

const inicio = () => horizonWindow(AMBER, [startPage()]);

const SUGGESTIONS = [
  { glyph: "search", title: "Buscar «ruta 40» en la web" },
  { glyph: "history", title: "Ruta 40: tramos de ripio y dónde cargar nafta", hint: "rutasdelsur.example" },
  { glyph: "star", title: "Mapa completo de la Ruta 40", hint: "Favoritos" },
  { glyph: "notebookPen", title: "Viaje a la Patagonia", hint: "Notebook" },
];

const buscar = () =>
  horizonWindow(AMBER, [startPage()], {
    bar: { value: "ruta 40", focus: true },
    overlays: [
      popover(
        { w: 1180, place: { x: 130, y: 92 }, name: "suggestions", label: "Sugerencias" },
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

const sitio = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Sitio" });

const shieldPopover = () =>
  popover(
    { w: 380, pad: 16, gap: 12, place: { x: 130, y: 92 }, name: "shield-panel", label: "Bloqueo de este sitio" },
    row({ gap: 10 }, badge("#2f6b4f", { initial: "R", size: 24, radius: 6 }), text("rutasdelsur.example", { size: "sm", weight: 600, color: "title" })),
    hr(),
    switchRow("Bloquear anuncios y rastreadores", true, { hint: "23 bloqueados: 15 anuncios, 6 rastreadores y 2 cookies", ref: "blocking" }),
    switchRow("Modo oscuro en este sitio", false, { ref: "site-dark" }),
    hr(),
    label("Permisos"),
    row({ h: 32, gap: 10 }, icon("map", { size: 16, color: "soft" }), text("Ubicación", { size: "sm", color: "title" }), fill(), text("Preguntar", { size: "sm", color: "soft" })),
    row({ h: 32, gap: 10 }, icon("bell", { size: 16, color: "soft" }), text("Notificaciones", { size: "sm", color: "title" }), fill(), text("Bloqueadas", { size: "sm", color: "soft" })),
  );

const escudo = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, overlays: [shieldPopover()], label: "Sitio" });

const oscuro = () =>
  horizonWindow(AMBER, [routesSite({ dark: true })], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, label: "Sitio en modo oscuro" });

// ---- profiles ---------------------------------------------------------------------

const profileRow = (name, color, active, hint) =>
  row(
    { h: 44, pad: [0, 10], gap: 10, radius: "sm", fill: active ? "wash" : undefined, name: `profile-${slug(name)}`, label: name },
    dot(color, 10),
    col({ grow: 1, gap: 0 }, text(name, { size: "sm", weight: active ? 600 : 400, color: "title" }), note(hint)),
    active ? icon("check", { size: 16, color: "primary" }) : null,
  );

const perfiles = () =>
  horizonWindow(AMBER, [startPage()], {
    overlays: [
      popover(
        { w: 280, place: { x: 10, y: 42 }, name: "profiles", label: "Perfiles" },
        profileRow("Personal", "primary", true, "3 pestañas"),
        profileRow("Trabajo", "info", false, "8 pestañas"),
        hr(),
        row({ h: 36, pad: [0, 10], gap: 10, name: "new-profile", label: "Nuevo perfil" }, icon("plus", { size: 16, color: "soft" }), text("Nuevo perfil", { size: "sm", color: "title" })),
        row({ h: 36, pad: [0, 10], gap: 10, name: "manage-profiles", label: "Administrar perfiles" }, icon("settings2", { size: 16, color: "soft" }), text("Administrar perfiles", { size: "sm", color: "title" })),
      ),
    ],
  });

// ---- research -----------------------------------------------------------------------

const lyraPermiso = () =>
  horizonWindow(AMBER, [routesSite({ width: 1040 })], {
    tabs: SITE_TABS,
    active: 1,
    bar: SITE_BAR,
    label: "Sitio",
    side: lyraPanel(
      bubble("Resumime esta página", { mine: true }),
      col(
        { pad: 16, gap: 10, radius: "lg", fill: "surface-2", stroke: "line", name: "lyra-permission", label: "Permiso para leer" },
        text("¿Puedo leer esta página?", { size: "base", weight: 650, color: "title" }),
        text("Para resumirla necesito leer rutasdelsur.example. Corro en tu máquina: nada sale de acá.", { size: "sm", color: "text" }),
        space(4),
        action("Permitir en este sitio", { primary: true, ref: "allow-site" }),
        row({ gap: 8 }, action("Solo esta vez", { grow: 1, ref: "allow-once" }), action("No", { grow: 1, ref: "deny" })),
      ),
    ),
  });

const lyraResumen = () =>
  horizonWindow(AMBER, [routesSite({ width: 1040 })], {
    tabs: SITE_TABS,
    active: 1,
    bar: SITE_BAR,
    label: "Sitio",
    side: lyraPanel(
      bubble("Resumime esta página", { mine: true }),
      bubble("Quedan tres tramos de ripio; el más largo tiene unos 70 km y conviene hacerlo de día. Entre estaciones puede haber más de 200 km, así que conviene cargar en cada pueblo."),
      row({ gap: 8 }, action("Guardar en notebook", { primary: true, glyph: "notebookPen", ref: "save-note" }), action("Comparar", { glyph: "columns2", ref: "compare" })),
      fill(),
      row({ h: 40, pad: [0, 12], gap: 10, radius: "md", fill: "field", stroke: "field-line", name: "ask-lyra", label: "Preguntale a Lyra" }, text("Preguntale a Lyra", { size: "sm", color: "dim" }), fill(), icon("send", { size: 16, color: "primary" })),
    ),
  });

const captura = () =>
  horizonWindow(AMBER, [routesSite(), box({ w: 1440, h: 804, fill: "rgba(0, 0, 0, 0.45)", place: { x: 0, y: 0 } }), box({ w: 820, h: 300, radius: 6, stroke: "primary", strokeWidth: 2, dash: "6 4", fill: "rgba(255, 176, 74, 0.08)", place: { x: 310, y: 262 }, name: "selection", label: "Zona elegida" })], {
    tabs: SITE_TABS,
    active: 1,
    bar: SITE_BAR,
    label: "Captura",
    overlays: [
      row(
        { h: 48, pad: [0, 8], gap: 10, radius: "lg", fill: "surface", stroke: "line-strong", place: { x: 430, y: 116 }, name: "capture-bar", label: "Barra de captura" },
        seg([{ label: "Texto", icon: "type" }, { label: "Zona", icon: "squareDashed" }, { label: "Página entera", icon: "appWindow" }], "Zona", { ref: "capture-kind" }),
        action("Guardar en notebook", { primary: true, glyph: "notebookPen", ref: "capture-save" }),
        action("Cancelar", { ghost: true, ref: "capture-cancel" }),
      ),
    ],
  });

const NOTEBOOK_TABS = [{ title: "Viaje a la Patagonia", glyph: "notebookPen" }, SITE_TABS[1], SITE_TABS[2]];

const notebook = () =>
  horizonWindow(
    AMBER,
    [
      row(
        { w: 1440, h: 804, place: { x: 0, y: 0 }, align: "stretch" },
        col(
          { w: 360, pad: 20, gap: 4, fill: "surface", edge: { side: "right", color: "line" }, name: "notebook-list", label: "Notas y capturas" },
          text("Viaje a la Patagonia", { size: "lg", weight: 650, color: "title" }),
          note("6 notas y 3 capturas"),
          space(12),
          row({ h: 50, gap: 12, radius: "sm", fill: "wash", pad: [0, 10], name: "item-capture", label: "Captura: tramos de ripio" }, icon("camera", { size: 16, color: "primary" }), text("Captura: tramos de ripio", { size: "sm", weight: 600, color: "title" })),
          ...NOTES.map((item) => noteRow(item, { source: false })),
        ),
        col(
          { grow: 1, pad: [28, 48], gap: 16, name: "notebook-item", label: "Captura abierta" },
          row(
            { gap: 10 },
            text("Captura: tramos de ripio", { size: "xl", weight: 650, color: "title" }),
            fill(),
            action("Enviar a", { glyph: "send", ref: "send-to" }),
          ),
          note("De rutasdelsur.example, hoy"),
          box({ h: 300, radius: "lg", fill: "#cdd6cc", name: "capture-image", label: "Imagen capturada" }),
          text("Hacer el tramo largo de día. Cargar nafta en cada pueblo.", { size: "base", color: "text" }),
        ),
      ),
    ],
    {
      tabs: NOTEBOOK_TABS,
      active: 0,
      bar: { value: "horizon://notebooks/viaje-a-la-patagonia", blocked: null },
      label: "Notebook",
      overlays: [
        popover(
          { w: 220, place: { x: 1170, y: 168 }, name: "send-menu", label: "Enviar a" },
          ...[["fileText", "Docs"], ["penTool", "Blueprint"], ["codeXml", "Nova"]].map(([glyph, app]) =>
            row({ h: 36, pad: [0, 10], gap: 10, radius: "sm", name: `send-${slug(app)}`, label: app }, icon(glyph, { size: 16, color: "soft" }), text(app, { size: "sm", color: "title" })),
          ),
        ),
      ],
    },
  );

// ---- passwords, extensions and sync ---------------------------------------------------

const INN = { bg: "#eef2f5", card: "#ffffff", ink: "#16222c", soft: "#5b6872", line: "#cfd8df", accent: "#1f5f8b" };
const LOGIN_TABS = [SITE_TABS[0], { title: "Hostería Lago Azul: tu reserva", color: "#1f5f8b", initial: "H" }];

const vault = () =>
  horizonWindow(
    AMBER,
    [
      col(
        { w: 1440, h: 804, fill: INN.bg, align: "center", pad: [96, 0], place: { x: 0, y: 0 }, name: "site", label: "Sitio: Hostería Lago Azul" },
        col(
          { w: 420, pad: 32, gap: 12, radius: 12, fill: INN.card, stroke: INN.line },
          text("Hostería Lago Azul", { face: "serif", size: 22, weight: 700, color: INN.ink }),
          text("Ingresá para ver tu reserva", { size: "sm", color: INN.soft }),
          space(8),
          text("Email", { size: "sm", weight: 600, color: INN.ink }),
          box({ h: 40, radius: 6, stroke: INN.accent, strokeWidth: 2, fill: INN.card, name: "email", label: "Email" }),
          space(150),
          text("Contraseña", { size: "sm", weight: 600, color: INN.ink }),
          box({ h: 40, radius: 6, stroke: INN.line, fill: INN.card }),
          space(6),
          row({ h: 42, radius: 6, fill: INN.accent, justify: "center" }, text("Ingresar", { size: "sm", weight: 600, color: "#ffffff" })),
        ),
      ),
    ],
    {
      tabs: LOGIN_TABS,
      active: 1,
      bar: { value: "lagoazul.example/ingresar", blocked: 4 },
      label: "Sitio",
      overlays: [
        popover(
          { w: 356, pad: 10, gap: 6, place: { x: 542, y: 396 }, name: "vault", label: "Vault" },
          row({ gap: 8, pad: [4, 6] }, icon("keyRound", { size: 16, color: "primary" }), text("Vault", { size: "sm", weight: 650, color: "title" })),
          row(
            { h: 48, pad: [0, 10], gap: 10, radius: "sm", fill: "wash", name: "vault-account", label: "Cuenta guardada" },
            badge("#1f5f8b", { initial: "H", size: 24, radius: 6 }),
            col({ grow: 1, gap: 0 }, text("ana.ferrer@ejemplo.com", { size: "sm", weight: 600, color: "title" }), note("lagoazul.example")),
          ),
          row({ gap: 8, pad: [4, 6] }, icon("fingerprint", { size: 14, color: "soft" }), note("Te pide la huella o el PIN de Windows antes de completar")),
        ),
      ],
    },
  );

const STORE_TABS = [SITE_TABS[0], { title: "Traductor Rápido: tienda de extensiones", color: "#4a6fa5", initial: "T" }];

const extension = () =>
  horizonWindow(
    AMBER,
    [
      col(
        { w: 1440, h: 804, fill: "#f4f6f8", pad: [40, 240], gap: 20, place: { x: 0, y: 0 }, name: "site", label: "Tienda de extensiones de Chrome" },
        text("Tienda de extensiones de Chrome", { size: "sm", color: "#4f5b66" }),
        row(
          { gap: 20, pad: 24, radius: 12, fill: "#ffffff", stroke: "#d8dee4" },
          badge("#4a6fa5", { glyph: "languages", size: 64, radius: 14 }),
          col({ grow: 1, gap: 4 }, text("Traductor Rápido", { size: "xl", weight: 650, color: "#1b2530" }), text("Traduce la página o lo que selecciones.", { size: "sm", color: "#4f5b66" })),
          row({ h: 40, pad: [0, 18], radius: 8, fill: "#4a6fa5", justify: "center", name: "add-extension", label: "Agregar" }, text("Agregar", { size: "sm", weight: 600, color: "#ffffff" })),
        ),
      ),
      box({ w: 1440, h: 804, fill: "overlay", place: { x: 0, y: 0 } }),
      col(
        { w: 460, pad: 24, gap: 12, radius: "xl", fill: "surface", stroke: "line-strong", place: { x: 490, y: 240 }, name: "extension-warning", label: "Aviso antes de instalar" },
        row({ gap: 10 }, icon("triangleAlert", { size: 20, color: "warning" }), text("Esta extensión puede no funcionar bien", { size: "base", weight: 650, color: "title" })),
        text("Usa funciones que Horizon todavía no tiene, como leer pestañas en segundo plano.", { size: "sm", color: "text" }),
        space(6),
        row({ gap: 8, justify: "end" }, action("Instalar igual", { ghost: true, ref: "install-anyway" }), action("Cancelar", { primary: true, ref: "cancel-install" })),
      ),
    ],
    { tabs: STORE_TABS, active: 1, bar: { value: "chromewebstore.google.com/detail/traductor-rapido", blocked: 2 }, label: "Tienda" },
  );

const SETTINGS = [["settings2", "General"], ["palette", "Apariencia"], ["shieldCheck", "Privacidad"], ["users", "Perfiles"], ["refreshCw", "Sync"], ["puzzle", "Extensiones"], ["sparkles", "Lyra"]];

const sync = () =>
  horizonWindow(
    DAYLIGHT,
    [
      row(
        { w: 1440, h: 804, place: { x: 0, y: 0 }, align: "stretch" },
        col(
          { w: 280, pad: 20, gap: 2, fill: "chrome", edge: { side: "right", color: "line" }, name: "settings-nav", label: "Secciones de ajustes" },
          row({ gap: 12, pad: [0, 8, 16, 8] }, mark(28), text("Ajustes", { size: "lg", weight: 650, color: "title" })),
          ...SETTINGS.map(([glyph, name]) =>
            row({ h: 38, pad: [0, 10], gap: 10, radius: "sm", fill: name === "Sync" ? "wash" : undefined, name: `settings-${slug(name)}`, label: name }, icon(glyph, { size: 16, color: name === "Sync" ? "primary" : "soft" }), text(name, { size: "sm", weight: name === "Sync" ? 600 : 400, color: "title" })),
          ),
        ),
        col(
          { w: 680, pad: [32, 56], gap: 8, name: "sync-settings", label: "Sync" },
          text("Sync", { size: "2xl", weight: 650, color: "title" }),
          row({ gap: 8 }, icon("lock", { size: 14, color: "success" }), text("Cifrado de extremo a extremo: Nebula no puede leer tus datos.", { size: "sm", color: "text" })),
          space(16),
          col(
            { pad: [8, 20], radius: "lg", fill: "surface", stroke: "line" },
            switchRow("Perfiles", true),
            hr(),
            switchRow("Favoritos", true),
            hr(),
            switchRow("Pestañas abiertas", true),
            hr(),
            switchRow("Notebooks", true),
            hr(),
            switchRow("Historial", false, { hint: "Apagado en este equipo" }),
          ),
          space(10),
          note("Usado: 120 MB de 5 GB"),
        ),
      ),
    ],
    { tabs: [{ title: "Ajustes", glyph: "settings2" }, SITE_TABS[1]], active: 0, bar: { value: "horizon://ajustes/sync", blocked: null }, label: "Ajustes" },
  );

export default board({
  id: "flows",
  title: "Flujos",
  note: "Cómo se usa Horizon, paso a paso. Hacé clic en una pantalla y este recuadro explica ese paso. Los sitios y los datos son inventados.",
  screens: [
    { id: "inicio", title: "1. Inicio", col: 0, row: 0, root: inicio, note: "Al abrir Horizon buscás o escribís una dirección. Abajo retomás tu último notebook." },
    { id: "buscar", title: "2. Buscar", col: 1, row: 0, root: buscar, note: "Mientras escribís, sugiere desde tu historial, favoritos y notebooks." },
    { id: "sitio", title: "3. Sitio abierto", col: 2, row: 0, root: sitio, note: "El sitio abre en su pestaña. El escudo cuenta lo bloqueado: 23 cosas acá." },
    { id: "escudo", title: "4. Bloqueo del sitio", col: 3, row: 0, root: escudo, note: "Si el sitio se rompe, apagás el bloqueo con un clic. También el modo oscuro y los permisos." },
    { id: "oscuro", title: "5. Modo oscuro", col: 4, row: 0, root: oscuro, note: "El sitio se ve oscuro aunque no lo tenga. Se elige por sitio." },
    { id: "perfiles", title: "6. Perfiles", col: 0, row: 1, root: perfiles, note: "Cada perfil tiene sus cookies, historial y cuentas. Personal y Trabajo no se mezclan." },
    { id: "lyra-permiso", title: "7. Lyra pide permiso", col: 2, row: 1, root: lyraPermiso, note: "Lyra lee una página solo si se lo pedís. La primera vez en cada sitio, pide permiso." },
    { id: "lyra-resumen", title: "8. Lyra resume", col: 3, row: 1, root: lyraResumen, note: "Resume o compara pestañas en tu máquina, y lo guardás en un notebook." },
    { id: "captura", title: "9. Captura", col: 2, row: 2, root: captura, note: "Capturás un texto, una zona o la página entera. Va primero a un notebook." },
    { id: "notebook", title: "10. Notebook", col: 4, row: 1, root: notebook, note: "Notas y capturas juntas. Desde acá mandás algo a Docs, Blueprint o Nova." },
    { id: "vault", title: "11. Vault completa", col: 0, row: 3, root: vault, note: "Vault sugiere tu cuenta solo en el sitio correcto y pide huella o PIN antes de completar." },
    { id: "extension", title: "12. Extensiones", col: 1, row: 3, root: extension, note: "Instalás desde la tienda de Chrome. Si una extensión usa algo que Horizon no tiene, avisa antes." },
    { id: "sync", title: "13. Sync (tema Daylight)", col: 2, row: 3, root: sync, note: "Todo se sincroniza cifrado por la nube de Nebula. Apagás lo que no quieras." },
  ],
  links: [
    { from: "inicio", to: "buscar", at: "search", label: "Escribir" },
    { from: "buscar", to: "sitio", at: "suggestion-2", label: "Abrir" },
    { from: "sitio", to: "escudo", at: "shield", label: "Escudo" },
    { from: "escudo", to: "oscuro", at: "site-dark-switch", label: "Modo oscuro" },
    { from: "inicio", to: "perfiles", at: "profile", label: "Perfil" },
    { from: "sitio", to: "lyra-permiso", at: "lyra", label: "Lyra" },
    { from: "lyra-permiso", to: "lyra-resumen", at: "allow-site", label: "Permitir" },
    { from: "lyra-resumen", to: "notebook", at: "save-note", label: "Guardar" },
    { from: "sitio", to: "captura", at: "notebooks", label: "Capturar" },
    { from: "captura", to: "notebook", at: "capture-save", label: "Guardar" },
  ],
});
