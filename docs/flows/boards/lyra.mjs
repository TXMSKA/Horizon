// Complete lyra flow; lanes read from left to right.
import { board } from "blueprint/board.mjs";
import { site, lyraHome, lyraMissing, lyraPermission, lyraComparePick, lyraProjectAsk, cloudDialog, withDialog, lyraSummary, lyraComparison, lyraProjectAnswer, desktopProject } from "../kit/horizon.mjs";

export default board({
  id: "lyra", title: "Lyra in the side panel",
  note: "Read each lane from left to right. Click a screen for its note. The sites and data are invented.",
  screens: [
    { id: "sitio", title: "1. Site open", col: 0, row: 2, root: site, note: "The round Lyra button opens the side panel. Lyra stays local by default." },
    { id: "home", title: "2. Lyra", col: 1, row: 1, root: lyraHome, note: "The local model is ready. Choose a suggestion or ask a question; answers are concise by default." },
    { id: "missing", title: "3. No local model", col: 1, row: 3, root: lyraMissing, note: "Install the shared local model, or quietly choose a free cloud tier or your own key." },
    { id: "permission", title: "4. Asks first", col: 2, row: 0, root: lyraPermission, note: "Lyra reads only when asked and asks permission the first time on each site. Nothing leaves this computer with the local model." },
    { id: "compare-pick", title: "5. Choose tabs", col: 2, row: 1, root: lyraComparePick, note: "Choose the open tabs to compare. Two are checked; page access remains subject to permission per site." },
    { id: "project-ask", title: "6. Ask about a project", col: 2, row: 2, root: lyraProjectAsk, note: "Choose Trip to Patagonia and send the question about what still needs booking." },
    { id: "cloud-warning", title: "7. Before using the cloud", col: 2, row: 3, root: () => withDialog(lyraMissing(), cloudDialog()), note: "The warning names the questions and pages that leave, the chosen provider and responsibility for later data collection. Cancel has focus." },
    { id: "summary", title: "8. Summary", col: 3, row: 0, root: lyraSummary, note: "A short local summary can be saved to Desktop with its source." },
    { id: "comparison", title: "9. Comparison", col: 3, row: 1, root: lyraComparison, note: "Lyra compares the two pages point by point and keeps both sources with the answer." },
    { id: "project-answer", title: "10. Answer from the project", col: 3, row: 2, root: lyraProjectAnswer, note: "The concise answer cites project items as chips and can be saved to Desktop." },
    { id: "saved", title: "11. Kept in the Desktop", col: 4, row: 1, root: () => desktopProject({ lyraSaved: true }), note: "The panel switches to Desktop with the saved Lyra item on top and its sources directly underneath." },
  ],
  links: [
    {"from":"sitio","at":"lyra","to":"home","label":"Lyra"},
    {"from":"sitio","at":"lyra","to":"missing","label":"No local model"},
    {"from":"home","at":"suggest-summary","to":"permission","label":"Summarise this page"},
    {"from":"home","at":"suggest-compare","to":"compare-pick","label":"Compare open tabs"},
    {"from":"home","at":"suggest-project","to":"project-ask","label":"Ask about a project"},
    {"from":"missing","at":"use-cloud","to":"cloud-warning","label":"Cloud option"},
    {"from":"permission","at":"allow-site","to":"summary","label":"Allow on this site"},
    {"from":"compare-pick","at":"compare-tabs","to":"comparison","label":"Compare"},
    {"from":"project-ask","at":"ask-send","to":"project-answer","label":"Send"},
    {"from":"summary","at":"save-desktop","to":"saved","label":"Save to Desktop"},
    {"from":"comparison","at":"save-desktop","to":"saved","label":"Save to Desktop"},
    {"from":"project-answer","at":"save-desktop","to":"saved","label":"Save to Desktop"},
  ],
});
