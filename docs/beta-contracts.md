# Beta integration contracts

What Horizon's Cosmic Beta relies on, who owns each part, and how each is accepted. Items marked **planned** do not exist yet in the owner's code; everything else exists today.

## Synced data

Sync carries the records of `electron/sync-model.ts`, grouped by the switches in `SYNC_ITEMS`. History starts off; every other switch starts on.

| Switch | Records | Owner |
| --- | --- | --- |
| profiles | Profile name, colour and creation time | Horizon |
| favorites | Favorites and folders with parent and position | Horizon |
| history | Visits (url, title, time) | Horizon |
| tabs | Each computer's open windows and tabs, shown as a list to open locally; never replaces local windows | Horizon |
| desktop | Desktop projects, folders, items and capture images (as blobs) | Horizon |
| siteSettings | Per-site blocking, dark pages, permissions, translation choices, clear-on-close switches | Horizon |
| settings | The supported app settings in `SYNC_SETTING_KEYS` | Horizon |
| computer | Each computer's name (always on) | Horizon |

Never synced: cookies and site sessions, Chromium caches, downloaded files, extension storage, Vault contents (passwords sync through Vault), account and provider credentials, Lyra models and memory, private-window activity, external service caches. A Lyra answer saved to the Desktop becomes ordinary Desktop content.

## Accounts and profiles

- One Cosmic account per Horizon profile. A profile syncs through its account only when it is explicitly assigned to that account; an account never syncs a profile it was not given (Tom, 2026-10-26).
- Local editing never depends on account state, plan or network. Sign-out, plan loss and service failure keep every local record.
- An account change cannot reuse another account's pending uploads, keys or incoming data.
- Private windows never sign in, sync, share or send; the refusals live in the main process.

## Transports

- A dataset has one active transport at a time: the folder the person chose, or Cosmic (Quantum). Changing it is an explicit switch that keeps local state and the pending outbox (Tom, 2026-10-26).
- Both transports carry the same `.hzs` objects and share publication, merge, conflict, checkpoint and recovery code (`docs/sync-engine.md`).
- Existing folder datasets stay readable after upgrading.
- Folder sync stays free and provider-neutral: the interface names no storage provider.
- Quantum transport (**planned**, task 038): personal dataset routes `/v1/datasets/{id}` and `/objects/{path}` exist today with Horizon's registered layout; uploads declare length and SHA-256 and identical retries succeed. Writer authorization uses the registered sign-in computer id. Quantum only ever stores encrypted objects.

## Capabilities

- Horizon reads the account's effective capabilities from Quantum and never compares plan labels (**planned** on Quantum's side; today `/v1/me` gives display name and plan labels only, which Horizon shows and does not interpret).
- Dawn, Dawn Lite and Insider are Quantum's plans; Horizon does not restate their prices, allowances or eligibility.
- Every protected action is checked in Horizon's main process and again by Quantum.

| Capability (**planned** names, Quantum's to fix) | Unlocks in Horizon |
| --- | --- |
| managed sync | The Cosmic transport for assigned profiles |
| shared Spaces | Shared with you, sharing a Desktop project (task 027, built) |

## Keys and encryption

- The account content key follows Quantum `docs/keys.md` (approved 2026-10-22). Horizon keeps its own public GPL implementation of the shared key store (Tom, 2026-10-22 and 2026-10-26): Windows DPAPI CurrentUser today; Linux protection to the same contract in task 034; no plaintext fallback.
- HKDF purposes used by Horizon: `cosmic/account/keypair` (account key pair), `cosmic/space/profile` (Space profile), `cosmic/space/<spaceId>/<generation>/horizon/project` and `.../manifest` (shared projects). Personal Quantum sync purposes are fixed in task 038 under `cosmic/account/horizon/<purpose>`.

## Lyra

- Lyra is the only model source: Horizon calls Lyra's public HTTP routes through `packages/horizon-lyra` and opens Lyra for model and provider management. No model weights, provider registry or provider credentials in Horizon.
- Automatic page translation runs only on Lyra's local route; remote routes (API key or connected CLI) run only on a manual request (Tom, 2026-10-26).
- **Planned** on Lyra's side: a frozen minimum version and capability contract for local, API-key and connected-CLI execution, streaming, cancellation and failures (task 036 waits on it).

## External dependencies and acceptance

| Dependency | Owner | State | Acceptance |
| --- | --- | --- | --- |
| Sign-in, `/v1/me`, Spaces and key routes | Quantum | Exists | Task 027 end to end against a local Quantum (two accounts) |
| Effective capabilities, consent requirements | Quantum | **Planned** | Task 035 with signed-out, unentitled, Dawn, Dawn Lite and Insider accounts |
| Personal dataset routes and layout | Quantum | Exists | Task 038, two installations converging |
| Change feed and Space key rotation | Quantum, Nebula | **Planned** | Task 040 with member removal and rotation |
| Authenticated Beta installer feed | Quantum (T16) | **Planned** | Task 043 |
| Lyra CLI and provider contract | Lyra | **Planned** | Task 036 through each route |
| Engine consumers | Nebula, Nova | Package built | Task 041 in the hosts on their Electron versions |
| Send receivers | Docs (Nebula), Nova; Blueprint at Release | Contract agreed | Task 041 with each receiver |
