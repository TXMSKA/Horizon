// Complete desktop flow; lanes read from left to right.
import { board } from "blueprint/board.mjs";
import { hub, desktopHome, desktopDrag, desktopNewProject, desktopProject, desktopCaptures, desktopEmpty, desktopSavedPage, desktopNote, desktop, shareDialog, withDialog, desktopTabGroup, desktopSendMenu, desktopSent } from "../kit/horizon.mjs";
function desktopStart() {
  const root = hub();
  function highlight(node) { if (node.name === "hub-desktop") { node.kids[0].stroke = "primary"; node.kids[0].strokeWidth = 2; node.kids[0].fill = "wash"; } for (const kid of node.kids ?? []) highlight(kid); }
  highlight(root); return root;
}
export default board({
  id: "desktop", title: "The Desktop: projects, captures and what you keep",
  note: "Read each lane from left to right. Click a screen for its note. The sites and data are invented.",
  screens: [
    { id: "start", title: "1. Hub, Desktop tile", col: 0, row: 2, root: desktopStart, note: "Choose Desktop in the Hub, or drag something to the right edge to keep it." },
    { id: "home", title: "2. Desktop", col: 1, row: 1, root: desktopHome, note: "Home shows recent Captures and projects. See all opens the kept screenshots; New project creates a place to keep related work." },
    { id: "drag", title: "3. Drag to the edge", col: 1, row: 3, root: desktopDrag, note: "With the panel closed, drag a link toward the right edge. Desktop peeks in with a drop area for Trip to Patagonia." },
    { id: "new-project", title: "4. New project", col: 2, row: 0, root: desktopNewProject, note: "Name the project and choose Create." },
    { id: "project", title: "5. Trip to Patagonia", col: 2, row: 1, root: desktopProject, note: "Folders hold pages, captures, notes and Lyra items with sources. Open an item or create a note or folder." },
    { id: "captures", title: "6. Captures", col: 2, row: 2, root: desktopCaptures, note: "All captures are kept locally by default. Add any screenshot to a project." },
    { id: "dropped", title: "7. Added", col: 2, row: 3, root: () => desktopProject({ dropped: true }), note: "The dropped page is on top and marked Added just now." },
    { id: "empty", title: "8. A new project", col: 3, row: 0, root: desktopEmpty, note: "The empty project explains what can be kept here and offers New note." },
    { id: "item", title: "9. A saved page", col: 3, row: 1, root: desktopSavedPage, note: "A saved page has a preview and note. Open it, ask Lyra, move it to a folder or delete it; the panel can open in a tab." },
    { id: "note", title: "10. A note", col: 3, row: 2, root: desktopNote, note: "Write a title and text. Changes are saved as typed." },
    { id: "tab", title: "11. Desktop in a tab", col: 4, row: 1, root: () => desktop({ share: true }), note: "The same project opens in a full tab with folders, mixed items, Share and Open as tab group." },
    { id: "share", title: "12. Share with a Space", col: 5, row: 0, root: () => withDialog(desktop({ share: true }), shareDialog()), note: "The same warning names the project and Lago Azul Studio. The project leaves this computer; Cancel has focus." },
    { id: "tab-group", title: "13. Open as tab group", col: 5, row: 2, root: desktopTabGroup, note: "The project pages open in the green Trip to Patagonia group; the first page is active." },
    { id: "send", title: "14. Send to", col: 4, row: 2, root: () => desktopSendMenu(), note: "Send to lists Docs, Blueprint and Nova. An app that cannot receive yet shows Not installed and does nothing. Notes, saved pages, text, captures and links can all be sent." },
    { id: "sent", title: "15. Sent to Docs", col: 4, row: 3, root: desktopSent, note: "Sent to Docs shows under the actions once the item is in Docs' inbox; Docs takes it the next time it reads its inbox. Nothing is sent from a private window." },
    { id: "changed-item", title: "Changed 9, A saved page", col: 0, row: -1, root: desktopSavedPage, note: "Changed 2026-10-22: Send to joins the item's actions, before Delete; the actions are accent buttons, Delete a bordered secondary." },
    { id: "changed-note", title: "Changed 10, A note", col: 1, row: -1, root: desktopNote, note: "Changed 2026-10-22: a note gets Send to under Saved as you type." },
    { id: "new-send", title: "New 14, Send to", col: 2, row: -1, root: () => desktopSendMenu(), note: "Approved 2026-10-22. Blueprint receives at its Release, so it shows Not installed in the Beta." },
    { id: "new-sent", title: "New 15, Sent to Docs", col: 3, row: -1, root: desktopSent, note: "Approved 2026-10-22." },
  ],
  links: [
    {"from":"start","at":"hub-desktop","to":"home","label":"Desktop"},
    {"from":"start","at":"start-page","to":"drag","label":"Drag to edge"},
    {"from":"home","at":"home-new-project","to":"new-project","label":"New project"},
    {"from":"home","at":"home-trip","to":"project","label":"Trip to Patagonia"},
    {"from":"home","at":"captures-see-all","to":"captures","label":"See all"},
    {"from":"drag","at":"edge-drop","to":"dropped","label":"Drop"},
    {"from":"new-project","at":"create-project","to":"empty","label":"Create"},
    {"from":"project","at":"item-inn","to":"item","label":"Lago Azul Inn"},
    {"from":"project","at":"desktop-new-note","to":"note","label":"New note"},
    {"from":"item","at":"panel-open-tab","to":"tab","label":"Open in a tab"},
    {"from":"item","at":"item-send","to":"send","label":"Send to"},
    {"from":"send","at":"send-docs","to":"sent","label":"Docs"},
    {"from":"tab","at":"project-share","to":"share","label":"Share"},
    {"from":"tab","at":"project-tab-group","to":"tab-group","label":"Open as tab group"},
  ],
});
