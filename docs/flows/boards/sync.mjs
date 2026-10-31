// Sync settings (task 039): a Cosmic account or a folder, the profiles each account syncs, and the way out of each failure.
import { board } from "blueprint/board.mjs";
import { col, row, text, icon } from "blueprint/kit.mjs";
import { action, hr, popover, seg, switcher } from "blueprint/ui.mjs";
import { AMBER, heading, slug, settingsWindow, settingsPage, settingsCard, settingsGroup, settingRow, withDialog } from "../kit/horizon.mjs";

const note = (value) => text(value, { size: "xs", color: "soft" });
const toggle = (title, on) => switcher(on, { ref: `${slug(title)}-switch`, label: title });
const encrypted = () => row({ gap: 8 }, icon("lock", { size: 14, color: "success" }), text("End-to-end encrypted: Cosmic cannot read what Horizon syncs.", { size: "sm", color: "text" }));
// One failure, its consequence and its single way out, as Settings shows feedback today.
const problem = (message, way, ref) => row({ pad: [12, 16], gap: 12, radius: "lg", fill: "surface", stroke: "error", name: `problem-${ref}`, label: message },
  icon("triangleAlert", { size: 16, color: "error" }), text(message, { size: "sm", color: "title", grow: 1 }), way ? action(way, { ref }) : null);
const waiting = (message, ref) => row({ pad: [12, 16], gap: 12, radius: "lg", fill: "surface", stroke: "line", name: `status-${ref}`, label: message },
  icon("clock", { size: 16, color: "soft" }), text(message, { size: "sm", color: "text", grow: 1 }));

const setup = () => settingsWindow(AMBER, "Sync", settingsPage("Sync", encrypted(),
  settingsGroup("Choose where Horizon syncs",
    settingRow("Cosmic account", "Through ana@example.test. Needs a plan that includes sync.", action("Use Cosmic account", { primary: true, ref: "use-cosmic" })), hr(),
    settingRow("A folder", "A folder you choose on this computer, kept in step by a service of your own", row({ gap: 8 }, action("Choose a folder", { ref: "choose-folder" }), action("Join with a code", { ghost: true, ref: "join-code" })))),
  note("Passwords sync through Vault, not here.")));

const items = (history = false) => settingsGroup("What syncs",
  ...[["Favorites", true], ["Open tabs", true], ["Desktop", true], ["Site settings", true], ["Settings", true], ["Profiles", true]].flatMap(([title, on]) => [settingRow(title, null, toggle(title, on)), hr()]),
  settingRow("History", history ? null : "Off on this computer", toggle("History", history)));

const cosmic = (...feedback) => settingsWindow(AMBER, "Sync", settingsPage("Sync", encrypted(), ...feedback,
  settingsCard(
    settingRow("Cosmic account", "ana@example.test · Synced 2 minutes ago", action("Sync now", { ref: "sync-now" })), hr(),
    settingRow("Location", "Cosmic account", action("Change", { ref: "change-location" })), hr(),
    settingRow("Stop syncing", "What is on this computer stays here", action("Stop syncing", { ref: "stop-syncing" }))),
  settingsGroup("Profiles synced with this account",
    settingRow("Personal", "This window", toggle("Personal", true)), hr(),
    settingRow("Work", "Stays on this computer", toggle("Work", false))),
  items()));

const changeDialog = () => popover({ w: 560, pad: 24, gap: 18, radius: "xl", shadow: false, name: "change-dialog", label: "Change where Horizon syncs" },
  col({ gap: 4 }, heading("Change where Horizon syncs"), note("One location at a time")),
  seg(["Cosmic account", "A folder"], "A folder", { ref: "location-choice" }),
  text("Changes not synced yet are kept and move to the new location once the current upload ends. Nothing is deleted from the old location.", { size: "sm", color: "text" }),
  row({ gap: 10, justify: "end" }, { ...action("Cancel", { ref: "change-cancel" }), stroke: "primary", strokeWidth: 2, label: "Cancel, focused" }, action("Choose a folder", { primary: true, ref: "change-confirm" })));

const signedOut = () => settingsWindow(AMBER, "Sync", settingsPage("Sync", encrypted(),
  problem("Signed out of the Cosmic account. Changes stay on this computer until it signs in again.", "Sign in", "sign-in"),
  settingsCard(settingRow("Location", "Cosmic account · kept for this computer", action("Change", { ref: "change-location" }))),
  items()));

const problems = () => settingsWindow(AMBER, "Sync", settingsPage("Sync", encrypted(),
  problem("Sync is not included in this account’s plan. Local data is kept.", "Manage account", "plan"),
  problem("The current Terms and Privacy policy need to be accepted on the Cosmic site.", "Review on the Cosmic site", "terms"),
  problem("The Cosmic storage is full. Changes stay on this computer until space is freed.", "Manage account", "full"),
  problem("This computer was removed from the account. Sign in again to sync.", "Sign in", "revoked"),
  waiting("Too many requests. Sync tries again at 14:32.", "rate"),
  waiting("Offline. 3 changes are kept on this computer and sync when the connection returns.", "offline")));

export default board({
  id: "sync", title: "Sync: a Cosmic account or a folder",
  note: "Settings > Sync for the Beta (task 039). One location at a time; each Cosmic account syncs only the profiles assigned to it; History starts off. The data is invented.",
  screens: [
    { id: "setup", title: "1. Choose where to sync", col: 0, row: 0, root: setup, note: "First time: a Cosmic account (managed sync, when the plan includes it) or a folder, as today." },
    { id: "cosmic", title: "2. Syncing with the Cosmic account", col: 1, row: 0, root: () => cosmic(), note: "Account and last sync, location, how to stop, and the profiles this account syncs. A profile switched off stays on this computer. What syncs continues below as today, History off." },
    { id: "change", title: "3. Change where Horizon syncs", col: 2, row: 0, root: () => withDialog(cosmic(), changeDialog()), note: "Switching keeps pending changes and moves them at a safe point. Cancel has focus." },
    { id: "plan", title: "4. Plan without sync", col: 1, row: 1, root: () => cosmic(problem("Sync is not included in this account’s plan. Local data is kept.", "Manage account", "plan")), note: "After a plan change: what is in Cosmic stays readable, new changes stay on this computer." },
    { id: "signed-out", title: "5. Signed out", col: 0, row: 1, root: signedOut, note: "The location is kept; changes wait on this computer until sign-in." },
    { id: "problems", title: "6. Each failure and its way out", col: 2, row: 1, root: problems, note: "One row per failure with its single action. Rate limits and being offline only wait." },
  ],
  links: [
    { from: "setup", at: "use-cosmic", to: "cosmic", label: "Use Cosmic account" },
    { from: "cosmic", at: "change-location", to: "change", label: "Change" },
  ],
});
