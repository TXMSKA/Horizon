# Beta integration contracts

What Horizon's Cosmic Beta relies on, who owns each part, and how each is accepted. Items marked **planned** do not exist yet in the owner's code; everything else exists today.

## Quantum 1.0.0-beta.2

Horizon targets Quantum's frozen **1.0.0-beta.2** contract (2026-10-29). `openapi.json` is authoritative for routes, schemas and errors; `api.md` and `keys.md` define identity, feed recovery and encryption semantics.

Beta.2 keeps Horizon's desktop sign-in at `/authorize/` without `clientId`, using its loopback callback; browser callback state and removed Blueprint sending do not change Horizon's sync or key contracts, and server pool usage now excludes pending Blueprint copies.

- `account.ts` uses OAuth's `account_id`, `/v1/me.accountId` and the active device's `accountId` as one canonical identity. `/v1/entitlements` supplies effective managed-sync capabilities; `acceptance_required` keeps task 035's browser consent flow. Account key envelopes use `/v1/keys` and `/v1/keys/public`.
- `quantum-feed.ts` shares one aggregate `/v1/changes` hold across profiles and personal/shared consumers of the same canonical account, seals its cursor, honors Retry-After and rebuilds through `/v1/bootstrap` and full listings after `410 cursor_expired`. No per-dataset idle polling is used.
- `sync-quantum.ts`, `sync-engine.ts` and `sync-transport.ts` use the personal dataset/object routes, millisecond metadata, immutable success envelopes, checksums, binary path cursors and aggregate additions/deletions. Publication still follows the existing engine pulse rules. The account descriptor and HKDF purpose frozen in task 038 are unchanged.
- `spaces.ts`, `space-sharing.ts` and `space-reader.ts` use paged Space/member/dataset metadata, current and historical key envelopes and `kg<n>/project/<writer>/<generation>/...` objects. Membership/key events invalidate local access revisions; rotation-required Spaces pause publication until a committed generation is available. Horizon cannot manage membership or commit rotations with its app token; the owner performs those operations in Nebula or the account site, as the frozen Shared Spaces section requires.
- `cosmic-crypto.ts` and `cosmic-keys.ts` retain the frozen key envelopes, context-bound additional data, HKDF purposes and canonical-account OS key-store entries. `sync-browser.ts` retains assigned-profile projection and local store validation; private windows and unshared content remain excluded.

Task 046's synthetic consumer checks do not replace the outstanding real two-account/local-Quantum and native Electron verification recorded in Quantum's `verification.md`.

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
- Quantum transport (task 038, main process): account-scoped enrollment and personal dataset routes `/v1/datasets/{id}` and `/objects/{path}` use Horizon's registered layout. Uploads declare SHA-256; Chromium supplies Content-Length, and identical retries succeed. Writers use the registered sign-in computer id. Only profiles assigned to that account are projected. Quantum only stores encrypted objects; the interface follows separately.

## Capabilities

- Horizon reads the account's effective capabilities from `/v1/entitlements` and never compares plan labels; `/v1/me` provides labels for display.
- Dawn, Dawn Lite and Insider are Quantum's plans; Horizon does not restate their prices, allowances or eligibility.
- Every protected action is checked in Horizon's main process and again by Quantum.

| Capability | Unlocks in Horizon |
| --- | --- |
| managed sync | The Cosmic transport for assigned profiles |
| shared Spaces | Shared with you, sharing a Desktop project (task 027, built) |

## Keys and encryption

- The account content key follows Quantum `docs/keys.md` (approved 2026-10-22). Horizon keeps its own public GPL implementation of the shared key store (Tom, 2026-10-22 and 2026-10-26): Windows DPAPI CurrentUser today; Linux protection to the same contract in task 034; no plaintext fallback.
- HKDF purposes used by Horizon: `cosmic/account/keypair` (account key pair), `cosmic/space/profile` (Space profile), `cosmic/space/<spaceId>/<generation>/horizon/project` and `.../manifest` (shared projects). Personal Quantum sync derives its 32-byte dataset key from K with HKDF-SHA256, empty salt and info `cosmic/account/horizon/sync/<datasetId>`; descriptors use `keyType: 'account'`. Existing folder descriptors retain `keyType: 'random'`.

## Lyra

- Lyra is the only model source: Horizon calls Lyra's public HTTP routes through `packages/horizon-lyra` and opens Lyra for model and provider management. No model weights, provider registry or provider credentials in Horizon.
- Automatic page translation runs only on Lyra's local route; remote routes (API key or connected CLI) run only on a manual request (Tom, 2026-10-26).
- **Planned** on Lyra's side: a frozen minimum version and capability contract for local, API-key and connected-CLI execution, streaming, cancellation and failures (task 036 waits on it).

## External dependencies and acceptance

| Dependency | Owner | State | Acceptance |
| --- | --- | --- | --- |
| Sign-in, `/v1/me`, Spaces and key routes | Quantum | Exists | Task 027 end to end against a local Quantum (two accounts) |
| Effective capabilities, consent requirements | Quantum | Frozen 1.0.0-beta.2 | Task 035 with signed-out, unentitled, Dawn, Dawn Lite and Insider accounts |
| Personal dataset routes and layout | Quantum | Exists | Task 038, two installations converging |
| Change feed and Space key rotation | Quantum, Nebula | Frozen 1.0.0-beta.2 | Task 040 with member removal and rotation |
| Authenticated Beta installer feed | Quantum (T16) | **Planned** | Task 043 |
| Lyra CLI and provider contract | Lyra | **Planned** | Task 036 through each route |
| Engine consumers | Nebula, Nova | Package built | Task 041 in the hosts on their Electron versions |
| Send receivers | Docs (Nebula), Nova; Blueprint at Release | Contract agreed | Task 041 with each receiver |
