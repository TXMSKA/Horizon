// Complete hub flow; lanes read from left to right.
import { board } from "blueprint/board.mjs";
import { col, row, stack, text } from "blueprint/kit.mjs";
import { popover, menuRow } from "blueprint/ui.mjs";
import { AMBER, FJORD, DUNE, GRAPHITE, MOSS, HUB_W, HUB_H, hubPopup, tileMenuPlace, themesPopup, scaled, site, hub, pin, themes, splitPick, split, splitOptions, translate, translateOptions, originalPage, nebula, nebulaSignedOut, nebulaSigningIn, nebulaSignedIn, nebulaPhrase, shareChooser, sharedProject, sharedItem, hubBetaGrid, shareDialog, withDialog, siteWindow, PINNED, horizonWindow, routesSite, SITE_TABS, SITE_BAR, startPage } from "../kit/horizon.mjs";
function closeup() {
  const home = hubPopup(); home.place = { x: 0, y: 0 };
  const menuHome = hubPopup({ pressed: "Split view" }); menuHome.place = { x: 0, y: 0 };
  const menu = stack({ w: HUB_W, h: HUB_H }, menuHome,
    popover({ w: 232, radius: "lg", shadow: false, place: tileMenuPlace(menuHome, 232) },
      menuRow("Open", { glyph: "externalLink", ref: "tile-open" }), menuRow("Add to quick access", { glyph: "pin", active: true, ref: "tile-pin" })));
  const themePanel = themesPopup(); themePanel.place = { x: 0, y: 0 };
  return row({ w: 1440, h: 900, theme: AMBER, fill: "page", pad: [16, 10], gap: 10, align: "start" },
    ...[[home, "Home", "home"], [menu, "Right-click a tile", "menu"], [themePanel, "Themes inside the Hub", "themes"]].map(([panel, caption, prefix]) =>
      col({ w: 468, gap: 12, align: "center" }, { ...scaled(panel, 1.3, prefix), place: undefined }, text(caption, { size: "sm", color: "soft", align: "center" }))));
}
const pinned = () => horizonWindow(AMBER, [routesSite()], { tabs: SITE_TABS, active: 1, bar: SITE_BAR, pinned: [...PINNED, { glyph: "columns2", label: "Split view", ref: "split-view" }] });
export default board({
  id: "hub", title: "The Hub and its apps",
  note: "Read each lane from left to right. Click a screen for its note. The sites and data are invented.",
  screens: [
    { id: "closeup", title: "1. The Hub up close", col: 0, row: 0, root: closeup, note: "The shared Hub at 1.3 times its size: Home, a tile menu and Themes. Capture stays in the top dock but leaves the app grid. Nebula is a proposal." },
    { id: "sitio", title: "2. Site open", col: 0, row: 2, root: site, note: "The toolbar holds Capture, Hub and the round Lyra button." },
    { id: "hub", title: "3. Hub", col: 1, row: 2, root: hub, note: "Home is current in the top dock, with Capture pinned. The six tiles open apps or act on the browser. Nebula is a proposal." },
    { id: "pin", title: "4. Quick access", col: 2, row: 0, root: pin, note: "Right-click Split view and choose Add to quick access." },
    { id: "split-pick", title: "5. Split view: choose a page", col: 2, row: 1, root: splitPick, note: "The current page moves left. Enter an address or choose an open tab or recent site on the right." },
    { id: "translate", title: "6. Translate", col: 2, row: 2, root: () => translate({ options: true }), note: "The page is translated from French. Its bar gives access to translation options." },
    { id: "themes", title: "7. Themes", col: 2, row: 4, root: themes, note: "Installed themes and marketplace themes live inside the Hub. Get a theme to apply it." },
    { id: "nebula", title: "8. Nebula (proposal)", col: 2, row: 3, root: nebula, note: "Executor proposal for the free tile: the account, Spaces, shared projects and sharing a project with a Space." },
    { id: "pinned", title: "9. Pinned", col: 3, row: 0, root: pinned, note: "The Hub closes and Split view is pinned beside Capture." },
    { id: "split", title: "10. Split view", col: 3, row: 1, root: () => split({ options: true }), note: "Rutas del Sur and Lago Azul Inn sit side by side. Each page keeps its own site badge." },
    { id: "translate-menu", title: "11. Translate options", col: 3, row: 2, root: translateOptions, note: "Choose a language, always translate French, exclude this site, or show the original." },
    { id: "theme-applied", title: "12. Theme applied", col: 3, row: 4, root: () => horizonWindow(FJORD, [startPage()]), note: "Fjord, a marketplace theme, repaints the window with cool, calm roles. Text reaches 4.5:1 and frames 3:1 against its surfaces." },
    { id: "share-space", title: "13. Share with a Space", col: 3, row: 3, root: () => withDialog(site(), shareDialog()), note: "Nebula proposal. The Hub closes when the dialog opens. The warning names what leaves this computer and the receiving Space; Cancel has focus." },
    { id: "split-menu", title: "14. Split view options", col: 4, row: 1, root: splitOptions, note: "The right page menu offers Swap sides, Open in its own tab and Close this side." },
    { id: "original", title: "15. Original", col: 4, row: 2, root: originalPage, note: "The French page is restored. The bar now offers Translate to English." },
    { id: "dune-applied", title: "16. Dune applied", col: 3, row: 5, root: () => horizonWindow(DUNE, [startPage()]), note: "Dune, a light marketplace theme: a dim sand floor, white-free raised layers and a deep clay accent on small marks. Text reaches 4.5:1 and frames 3:1 against its surfaces." },
    { id: "graphite-applied", title: "17. Graphite applied", col: 3, row: 6, root: () => horizonWindow(GRAPHITE, [startPage()]), note: "Graphite, a dark marketplace theme: near-neutral greys with a calm periwinkle accent. Text reaches 4.5:1 and frames 3:1 against its surfaces." },
    { id: "moss-applied", title: "18. Moss applied", col: 3, row: 7, root: () => horizonWindow(MOSS, [startPage()]), note: "Moss, a light marketplace theme: a sage-grey floor and a deep moss accent. Text reaches 4.5:1 and frames 3:1 against its surfaces." },
    { id: "new-hub-grid", title: "New 19, Hub with Nebula, two by two", col: 5, row: -1, root: hubBetaGrid, note: "Approved 2026-10-22: the Hub as built gains a Nebula tile, in two rows of two." },
    { id: "new-nebula-out", title: "New 20, Nebula before sign-in", col: 6, row: -1, root: nebulaSignedOut, note: "Approved 2026-10-22. Sign in opens the Cosmic account site in the default browser; Google and Microsoft refuse sign-in inside an app's own browser." },
    { id: "new-nebula-wait", title: "New 21, Signing in", col: 7, row: -1, root: nebulaSigningIn, note: "Approved 2026-10-22. Horizon waits for the browser to return to it; Cancel stops waiting." },
    { id: "new-nebula-in", title: "New 22, Signed in", col: 8, row: -1, root: nebulaSignedIn, note: "Approved 2026-10-22. The account shows its address until Quantum serves a display name and plan; Spaces and Shared with you join this page once Quantum serves Spaces (screen 8)." },
    { id: "new-nebula-phrase", title: "New 23, Recovery phrase", col: 9, row: -1, root: nebulaPhrase, note: "Approved 2026-10-22. Shown after sign-in only when no Cosmic app on this computer holds the account key yet; afterwards the page shows the Spaces (screen 8)." },
    { id: "new-share-chooser", title: "New 24, Choose what to share", col: 10, row: -1, root: () => withDialog(site(), shareChooser()), note: "Approved 2026-10-22. Opened by Share a project in Nebula, or by Share in a Desktop project with the project already chosen; Next leads to the warning (screen 13)." },
    { id: "new-shared-project", title: "New 25, A shared project", col: 11, row: -1, root: sharedProject, note: "Approved 2026-10-22. A project under Shared with you opens in the Desktop panel to read, with who shared it and in which Space." },
    { id: "new-shared-item", title: "New 26, A shared item", col: 12, row: -1, root: sharedItem, note: "Approved 2026-10-22. An item of a shared project offers only Open page and Ask Lyra; nothing is moved, sent or deleted." },
    { id: "changed-closeup", title: "Changed 1, The Hub up close", col: 0, row: -1, root: closeup, note: "Changed 2026-10-08: Themes up close shows Dune, Graphite and Moss in their own palettes instead of placeholders." },
    { id: "changed-themes", title: "Changed 7, Themes", col: 1, row: -1, root: themes, note: "Changed 2026-10-08: the marketplace previews of Dune, Graphite and Moss use their own palettes." },
    { id: "new-dune", title: "New 16, Dune applied", col: 2, row: -1, root: () => horizonWindow(DUNE, [startPage()]), note: "New 2026-10-08, for the owner's approval before it ships." },
    { id: "new-graphite", title: "New 17, Graphite applied", col: 3, row: -1, root: () => horizonWindow(GRAPHITE, [startPage()]), note: "New 2026-10-08, for the owner's approval before it ships." },
    { id: "new-moss", title: "New 18, Moss applied", col: 4, row: -1, root: () => horizonWindow(MOSS, [startPage()]), note: "New 2026-10-08, for the owner's approval before it ships." },
  ],
  links: [
    {"from":"sitio","at":"hub","to":"hub","label":"Hub"},
    {"from":"hub","at":"hub-split-view","to":"pin","label":"Right-click"},
    {"from":"hub","at":"hub-split-view","to":"split-pick","label":"Split view"},
    {"from":"hub","at":"hub-translate","to":"translate","label":"Translate"},
    {"from":"hub","at":"hub-themes","to":"themes","label":"Themes"},
    {"from":"hub","at":"hub-nebula","to":"nebula","label":"Nebula"},
    {"from":"pin","at":"add-quick-access","to":"pinned","label":"Add to quick access"},
    {"from":"split-pick","at":"pick-inn","to":"split","label":"Lago Azul Inn"},
    {"from":"translate","at":"translate-menu-button","to":"translate-menu","label":"Options"},
    {"from":"themes","at":"get-fjord","to":"theme-applied","label":"Get Fjord"},
    {"from":"themes","at":"get-dune","to":"dune-applied","label":"Get Dune"},
    {"from":"themes","at":"get-graphite","to":"graphite-applied","label":"Get Graphite"},
    {"from":"themes","at":"get-moss","to":"moss-applied","label":"Get Moss"},
    {"from":"nebula","at":"nebula-share","to":"share-space","label":"Share a project"},
    {"from":"split","at":"split-menu-button","to":"split-menu","label":"Options"},
    {"from":"translate-menu","at":"menu-show-original","to":"original","label":"Show original"},
  ],
});
