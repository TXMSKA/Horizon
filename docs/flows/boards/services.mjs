// Installing Vault and Lyra from Horizon, as the shared-services contract asks (task 031); lanes read from left to right.
// Every dialog is built from the boards' own dialog pieces: centred, focus on the safe action, sizes shown before the OK.
import { board } from "blueprint/board.mjs";
import { col, row, text } from "blueprint/kit.mjs";
import { popover, action, progress, hr } from "blueprint/ui.mjs";
import { AMBER, site, withDialog, heading, panelWindow, settingsWindow, settingsPage, settingsGroup, settingRow } from "../kit/horizon.mjs";

const body = value => text(value, { size: "sm", color: "text" });
const dialog = (name, title, ...kids) => popover({ w: 560, pad: 24, gap: 18, radius: "xl", shadow: false, name, label: title }, heading(title), ...kids);
// The safe action keeps the focus ring, as in every confirmation of the boards.
const focused = (value, ref) => ({ ...action(value, { ref }), stroke: "primary", strokeWidth: 2, label: `${value}, focused` });
const buttons = (...kids) => row({ gap: 10, justify: "end" }, ...kids);
const pageLink = (value, ref) => ({ ...action(value, { ghost: true, glyph: "externalLink", ref }), pad: 0, justify: "start", self: "start" });

const vaultOffer = () => dialog("vault-offer", "Install Vault to keep passwords",
  body("Vault stores passwords and keys on this computer, encrypted, and shares them with Horizon, Nova and Nebula. It is free and open source. Installing it downloads about 42 MB from GitHub (TXMSKA/Vault)."),
  pageLink("What is Vault?", "vault-about"),
  buttons(focused("Not now", "vault-not-now"), action("Install", { primary: true, ref: "vault-install" })));
const lyraOffer = () => dialog("lyra-offer", "Install Lyra to use the assistant",
  body("Lyra runs the assistant on this computer, at no cost. Its setup shows the models it needs and their size before downloading them. Installing it downloads about 85 MB from GitHub (TXMSKA/lyra-releases)."),
  pageLink("What is Lyra?", "lyra-about"),
  buttons(focused("Not now", "lyra-not-now"), action("Install", { primary: true, ref: "lyra-install" })));
const downloading = () => dialog("vault-downloading", "Installing Vault",
  body("Downloading 18 of 42 MB from GitHub (TXMSKA/Vault)."), progress(0.43, { w: 512 }),
  buttons(focused("Cancel", "download-cancel")));
const installing = () => dialog("vault-installing", "Installing Vault",
  body("The download matches its published checksum. Vault is being installed for this Windows account."), progress(0.9, { w: 512 }),
  buttons(action("Cancel", { ref: "install-cancel" })));
const finish = () => dialog("vault-finish", "Finish setting up Vault in its window",
  body("Vault opened its own window to create the vault and its recovery kit. Horizon continues on its own once Vault is ready."),
  buttons(focused("Close", "finish-close")));
const failed = () => dialog("vault-failed", "Vault could not be installed",
  body("The download did not match its published checksum, so it was deleted and nothing was installed. Vault can also be installed from its download page."),
  buttons(action("Open download page", { glyph: "externalLink", ref: "failed-download-page" }), focused("Retry", "failed-retry")));
const didNotStart = () => dialog("vault-not-started", "Vault did not start",
  body("Vault is installed on this computer but did not answer. Retry, or reinstall it from its latest release."),
  buttons(action("Reinstall", { ref: "not-started-reinstall" }), focused("Retry", "not-started-retry")));

const lyraPanel = () => panelWindow("Lyra", heading("Lyra"), body("Lyra is not installed on this computer."));
const settings = () => settingsWindow(AMBER, "General", settingsPage("General",
  settingsGroup("Shared services",
    settingRow("Vault", "Passwords and keys, shared by the Cosmic apps. Installed, version 0.1.0", action("Open Vault", { glyph: "externalLink", ref: "settings-open-vault" })), hr(),
    settingRow("Lyra", "The assistant, shared by the Cosmic apps. Not installed", action("Install", { ref: "settings-install-lyra" })))));

export default board({
  id: "services", title: "Installing Vault and Lyra when a feature needs them",
  note: "Proposal for task 031, from the shared-services contract approved on 2026-10-09. Sizes are examples until each release names its own. Read each lane from left to right.",
  screens: [
    { id: "vault-offer", title: "1. Vault offer", col: 0, row: 0, root: () => withDialog(site(), vaultOffer()), note: "Shown when the Passwords panel, Import's passwords or a save asks for Vault and Vault is not installed. Never at first launch, never on a sign-in field. Not now holds until Horizon restarts." },
    { id: "downloading", title: "2. Downloading", col: 1, row: 0, root: () => withDialog(site(), downloading()), note: "Only after Install: the latest release's installer over HTTPS from GitHub, into a private temporary folder. Cancel deletes the download." },
    { id: "installing", title: "3. Installing", col: 2, row: 0, root: () => withDialog(site(), installing()), note: "The SHA-256 matched the release's SHA256SUMS.txt. The installer runs silently, per user, without elevation." },
    { id: "finish", title: "4. Finish in Vault", col: 3, row: 0, root: () => withDialog(site(), finish()), note: "Vault's own window creates the vault and the recovery kit. Horizon never asks for Vault's master password here and connects once Vault reports it is ready." },
    { id: "lyra-offer", title: "5. Lyra offer", col: 0, row: 1, root: () => withDialog(lyraPanel(), lyraOffer()), note: "Shown when the person opens Lyra's panel or asks to translate a page and Lyra is not installed. The same frame as Vault's, with Lyra's own text." },
    { id: "failed", title: "6. Install failed", col: 1, row: 1, root: () => withDialog(site(), failed()), note: "Any failure deletes the download and offers the manual path: the download page opens in the system browser." },
    { id: "not-started", title: "7. Did not start", col: 2, row: 1, root: () => withDialog(site(), didNotStart()), note: "The service is installed but its start timed out or its install record is invalid." },
    { id: "settings", title: "8. Shared services in Settings", col: 3, row: 1, root: settings, note: "Settings, General lists Vault and Lyra and offers each missing one again." },
  ],
  links: [
    {"from":"vault-offer","at":"vault-install","to":"downloading","label":"Install"},
    {"from":"downloading","at":"vault-downloading","to":"installing","label":"Checksum matches"},
    {"from":"installing","at":"vault-installing","to":"finish","label":"Installed"},
  ],
});
