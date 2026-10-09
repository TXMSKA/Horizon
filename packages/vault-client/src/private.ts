import fs from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { VaultClientError } from "./errors.ts";
import { runHelper, runHelperSync } from "./helper.ts";

// ACLs protect all service data, including ciphertext, discovery and audit records.
// A fresh descriptor carries only the owner and the access list; rewriting one read back from the folder also writes the audit list, which needs a privilege users lack once the folder is protected.
// The native helper sets the descriptor, reads it back and fails unless it is exactly the owner and the three allowed accounts.
// `home` names the Vault install whose helper does the work; it defaults to the one this process resolves.
// The async forms are for hosts: a helper build's first run can wait on the antivirus for half a minute, and a host's main thread must not.

// Checks and creates the folder; answers the folder the helper still has to protect on Windows, or nothing when it is done.
function folder(directory: string): string | undefined {
  directory = resolve(directory);
  if (!isAbsolute(directory) || /^\\\\/.test(directory) || /[\x00-\x1f]/.test(directory) || directory.split(/[\\/]/).some(part => /^(?:onedrive(?: - .*)?|dropbox|google drive|icloud drive)$/i.test(part))) throw new Error();
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error(); ancestor = parent; }
  const resolvedAncestor = fs.realpathSync.native(ancestor);
  if (process.platform === "win32" ? resolvedAncestor.toLowerCase() !== ancestor.toLowerCase() : resolvedAncestor !== ancestor) throw new Error();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const actual = fs.realpathSync.native(directory);
  if ((process.platform === "win32" ? actual.toLowerCase() !== directory.toLowerCase() : actual !== directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error();
  if (process.platform !== "win32") { if (fs.statSync(directory).uid !== process.getuid?.()) throw new Error(); fs.chmodSync(directory, 0o700); return undefined; }
  return directory;
}
// Checks the file; answers whether the helper still has to check its descriptor on Windows.
function file(filename: string): boolean {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  if (process.platform !== "win32") { fs.chmodSync(filename, 0o600); if (stat.uid !== process.getuid?.()) throw new Error(); return false; }
  return true;
}
const unsafe = (error: unknown) => new VaultClientError("unsafe_location", { cause: error });
export function privateDirectory(directory: string, home?: string): void {
  try { const path = folder(directory); if (path) runHelperSync("protect-folder", { path }, { home }); } catch (error) { throw unsafe(error); }
}
export function privateFile(filename: string, home?: string): void {
  try { if (file(filename)) runHelperSync("check-file", { path: filename }, { home }); } catch (error) { throw unsafe(error); }
}
export async function privateDirectoryAsync(directory: string, home?: string): Promise<void> {
  try { const path = folder(directory); if (path) await runHelper("protect-folder", { path }, { home }); } catch (error) { throw unsafe(error); }
}
export async function privateFileAsync(filename: string, home?: string): Promise<void> {
  try { if (file(filename)) await runHelper("check-file", { path: filename }, { home }); } catch (error) { throw unsafe(error); }
}
export function prepareHome(home: string) {
  privateDirectory(home);
  for (const name of ["run", "secrets", "store", "logs"]) privateDirectory(join(home, name));
}
export function privateParent(filename: string) { privateDirectory(dirname(filename)); }
