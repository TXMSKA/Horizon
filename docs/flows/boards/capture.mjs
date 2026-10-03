// Complete capture flow; lanes read from left to right.
import { board } from "blueprint/board.mjs";
import { captureSite, captureShot, captureEditor, captureSaved, lyraCaptureAnswer } from "../kit/horizon.mjs";

export default board({
  id: "capture", title: "Capture: a screenshot first",
  note: "Read each lane from left to right. Click a screen for its note. The sites and data are invented.",
  screens: [
    { id: "sitio", title: "1. Site open", col: 0, row: 1, root: captureSite, note: "Capture is pinned by default; Settings can hide it. Use Capture or Ctrl+Shift+S." },
    { id: "shot", title: "2. Screenshot", col: 1, row: 1, root: captureShot, note: "One press captures the visible page. The page stays as it is; the preview opens under the toolbar on the right and the image is kept locally." },
    { id: "save-to", title: "3. Save to a project", col: 2, row: 0, root: () => captureShot({ selector: true }), note: "The Save chevron opens the shared selector. Search projects; the current project is checked, then the others follow by last use." },
    { id: "crop", title: "4. Crop", col: 2, row: 1, root: captureEditor, note: "Adjust the four crop corners. Screen is chosen; use Full page, Cancel, or save with the same project selector." },
    { id: "shot-lyra", title: "5. Ask Lyra about it", col: 2, row: 2, root: lyraCaptureAnswer, note: "The screenshot is attached to the question. Lyra gives a short answer locally and can save it to Desktop." },
    { id: "saved", title: "6. Saved", col: 3, row: 0, root: captureSaved, note: "The page stays as it was. Open goes to Trip to Patagonia." },
    { id: "full-page", title: "7. Full page", col: 3, row: 1, root: () => captureEditor({ full: true }), note: "The entire page is scaled to fit as a tall strip. Save uses the same project selector." },
  ],
  links: [
    {"from":"sitio","at":"capture","to":"shot","label":"Capture"},
    {"from":"shot","at":"capture-projects","to":"save-to","label":"Choose project"},
    {"from":"shot","at":"capture-crop","to":"crop","label":"Crop"},
    {"from":"shot","at":"capture-lyra","to":"shot-lyra","label":"Lyra"},
    {"from":"save-to","at":"save-project-trip","to":"saved","label":"Trip to Patagonia"},
    {"from":"crop","at":"editor-kind-full-page","to":"full-page","label":"Full page"},
  ],
});
