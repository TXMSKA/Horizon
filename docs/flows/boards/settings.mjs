// Settings flow; one page in a tab, each section opened from the rail.
import { board } from "blueprint/board.mjs";
import { box, col, row, stack, text } from "blueprint/kit.mjs";
import { action, badge, btn, checkbox, dot, hr, input, label, popover, seg, switcher } from "blueprint/ui.mjs";
import { AMBER, heading, slug, settingsWindow, settingsPage, settingsSubpage, settingsCard, settingsGroup, settingRow, settingsGeneral, withDialog } from "../kit/horizon.mjs";

const note = (value) => text(value, { size: "xs", color: "soft" });
const toggle = (title, on) => switcher(on, { ref: `${slug(title)}-switch`, label: title });

const appearance = () => settingsWindow(AMBER, "Appearance", settingsPage("Appearance",
  settingsGroup("Horizon",
    settingRow("Theme", "Amber, Daylight or the one Windows uses", seg(["System", "Amber", "Daylight"], "Amber", { ref: "theme" })), hr(),
    settingRow("High contrast", "Pure black and white, with stronger edges", toggle("High contrast", false)), hr(),
    settingRow("Show Capture in the toolbar", "Ctrl+Shift+S captures either way", toggle("Show Capture in the toolbar", true))),
  settingsGroup("Web pages",
    settingRow("Dark pages", "Darkens sites that have no dark theme of their own", seg(["Off", "On", "System"], "On", { ref: "dark-pages" })), hr(),
    settingRow("Strength", null, seg(["Soft", "Standard", "Deep"], "Standard", { ref: "dark-strength" })), hr(),
    settingRow("Tone", null, seg(["Neutral", "Warm"], "Neutral", { ref: "dark-tone" })))));

const privacy = () => settingsWindow(AMBER, "Privacy", settingsPage("Privacy",
  settingsGroup("Blocking",
    settingRow("Block ads and trackers", "On every site; turn it off for one site from the shield in the address bar", toggle("Block ads and trackers", true)), hr(),
    settingRow("Block third-party cookies", "Stops sites from following you across other sites", toggle("Block third-party cookies", true)), hr(),
    settingRow("Sites with their own settings", "3 sites: blocking, dark pages and permissions", action("Manage", { ref: "privacy-sites" }))),
  settingsGroup("Browsing data",
    settingRow("Clear browsing data", "History, cookies and cached files of this profile", action("Clear", { ref: "clear-now" })), hr(),
    settingRow("Clear history when Horizon closes", null, toggle("Clear history when Horizon closes", false)), hr(),
    settingRow("Clear cached files when Horizon closes", null, toggle("Clear cached files when Horizon closes", false)))));

const siteRow = (host, initial, color, summary) => row({ pad: [12, 0], gap: 12, name: `site-${slug(host)}`, label: host },
  badge(color, { initial, size: 24, radius: "sm", ink: "site-ink" }),
  col({ grow: 1, gap: 2 }, text(host, { size: "sm", weight: 600, color: "title" }), note(summary)),
  action("Reset", { ref: `reset-${slug(host)}` }));
const sites = () => settingsWindow(AMBER, "Privacy", settingsSubpage("Privacy", "Sites with their own settings",
  settingsCard(
    siteRow("rutasdelsur.example", "R", "site-routes", "Blocking off · Dark page on"), hr(),
    siteRow("lagoazul.example", "L", "site-inn", "Location allowed"), hr(),
    siteRow("masa.example", "S", "site-bread", "Notifications blocked")),
  note("Reset forgets what a site was allowed or turned off; it asks again next time.")));

const clearDialog = () => popover({ w: 560, pad: 24, gap: 18, radius: "xl", shadow: false, name: "clear-dialog", label: "Clear browsing data" },
  col({ gap: 4 }, heading("Clear browsing data"), note("From this profile, for all time")),
  col({ gap: 12 }, ...["Browsing history", "Cookies and site data", "Cached images and files"].map(title =>
    row({ gap: 10, name: `clear-${slug(title)}`, label: title }, checkbox(true), text(title, { size: "sm", color: "title" })))),
  text("Clearing cookies signs you out of most sites.", { size: "sm", color: "text" }),
  row({ gap: 10, justify: "end" }, { ...action("Cancel", { ref: "clear-cancel" }), stroke: "primary", strokeWidth: 2, label: "Cancel, focused" }, action("Clear", { primary: true, ref: "clear-confirm" })));

const PROFILE_SWATCHES = ["primary", "info", "success", "error", "warning", "soft", "title", "dim"];
const profileItem = (name, color, hint, current) => row({ pad: [12, 0], gap: 12, name: `profile-${slug(name)}`, label: name },
  stack({ w: 24, h: 24 }, { ...dot(color, 10), place: "center" }),
  col({ grow: 1, gap: 2 }, text(name, { size: "sm", weight: 600, color: "title" }), note(hint)),
  current ? null : action("Switch", { ghost: true, ref: `switch-${slug(name)}` }),
  action("Edit", { ref: `edit-${slug(name)}` }),
  btn("trash2", { label: `Delete ${name}`, ref: `delete-${slug(name)}` }));
const swatch = (color, on) => stack({ w: 26, h: 26, radius: "pill", stroke: on ? "title" : undefined, strokeWidth: 2, name: `colour-${color}`, label: on ? "Chosen colour" : "Colour" },
  box({ w: 18, h: 18, radius: "pill", fill: color, place: "center" }));
const profileForm = () => col({ pad: [0, 0, 16, 36], gap: 16, name: "profile-form", label: "Edit Work" },
  col({ gap: 6 }, label("Name"), input("Profile name", { glyph: null, value: "Work", focus: true })),
  col({ gap: 6 }, label("Colour"), row({ gap: 6 }, ...PROFILE_SWATCHES.map(color => swatch(color, color === "info")))),
  row({ gap: 8, justify: "end" }, action("Cancel", { ghost: true, ref: "edit-cancel" }), action("Save", { primary: true, ref: "edit-save" })));
const profiles = ({ editing = false } = {}) => settingsWindow(AMBER, "Profiles", settingsPage("Profiles",
  settingsCard(
    profileItem("Personal", "primary", "This window · 3 tabs", true), hr(),
    profileItem("Work", "info", "2 tabs", false), editing ? profileForm() : null),
  row({}, action("New profile", { glyph: "plus", ref: "new-profile" }))));

export default board({
  id: "settings", title: "Settings: one page in a tab",
  note: "Settings opens in a tab from the three-dot menu; the rail moves between sections. Click a screen for its note. The data is invented.",
  screens: [
    { id: "general", title: "1. General", col: 0, row: 1, root: settingsGeneral, note: "Make Horizon the default browser, choose the search engine, the downloads folder and the language." },
    { id: "appearance", title: "2. Appearance", col: 1, row: 0, root: appearance, note: "The theme and contrast of Horizon itself, whether Capture shows in the toolbar, and dark pages for sites without a dark theme." },
    { id: "privacy", title: "3. Privacy", col: 1, row: 1, root: privacy, note: "Blocking stays on everywhere unless a site is excepted from the shield. Clear this profile's browsing data now or each time Horizon closes." },
    { id: "profiles", title: "4. Profiles", col: 1, row: 3, root: () => profiles(), note: "Switch, edit or delete a profile, or create a new one. The last profile cannot be deleted." },
    { id: "sites", title: "5. Sites with their own settings", col: 2, row: 1, root: sites, note: "Every site with blocking off, a dark-page choice or a permission. Reset forgets it." },
    { id: "clear", title: "6. Clear browsing data", col: 2, row: 2, root: () => withDialog(privacy(), clearDialog()), note: "Choose what to clear from this profile. Cancel has focus." },
    { id: "profile-edit", title: "7. Edit a profile", col: 2, row: 3, root: () => profiles({ editing: true }), note: "Rename the profile and choose its colour; Save applies both." },
  ],
  links: [
    {"from":"general","at":"settings-appearance","to":"appearance","label":"Appearance"},
    {"from":"general","at":"settings-privacy","to":"privacy","label":"Privacy"},
    {"from":"general","at":"settings-profiles","to":"profiles","label":"Profiles"},
    {"from":"privacy","at":"privacy-sites","to":"sites","label":"Manage"},
    {"from":"privacy","at":"clear-now","to":"clear","label":"Clear"},
    {"from":"profiles","at":"edit-work","to":"profile-edit","label":"Edit"},
  ],
});
