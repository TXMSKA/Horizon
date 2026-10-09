import fs from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { VaultClientError } from "./errors.ts";
import { runHelperSync } from "./helper.ts";

// ACLs protect all service data, including ciphertext, discovery and audit records.
// A fresh descriptor carries only the owner and the access list; rewriting one read back from the folder also writes the audit list, which needs a privilege users lack once the folder is protected.
// The native helper sets the descriptor, reads it back and fails unless it is exactly the owner and the three allowed accounts.
export function privateDirectory(directory: string): void {
  directory = resolve(directory);
  try {
    if (!isAbsolute(directory) || /^\\\\/.test(directory) || /[\x00-\x1f]/.test(directory) || directory.split(/[\\/]/).some(part => /^(?:onedrive(?: - .*)?|dropbox|google drive|icloud drive)$/i.test(part))) throw new Error();
    let ancestor = directory;
    while (!fs.existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error(); ancestor = parent; }
    const resolvedAncestor = fs.realpathSync.native(ancestor);
    if (process.platform === "win32" ? resolvedAncestor.toLowerCase() !== ancestor.toLowerCase() : resolvedAncestor !== ancestor) throw new Error();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const actual = fs.realpathSync.native(directory);
    if ((process.platform === "win32" ? actual.toLowerCase() !== directory.toLowerCase() : actual !== directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error();
    if (process.platform !== "win32") { if (fs.statSync(directory).uid !== process.getuid?.()) throw new Error(); fs.chmodSync(directory, 0o700); return; }
    runHelperSync("protect-folder", { path: directory });
  } catch (error) { throw new VaultClientError("unsafe_location", { cause: error }); }
}
export function privateFile(filename: string): void {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    if (process.platform !== "win32") { fs.chmodSync(filename, 0o600); if (stat.uid !== process.getuid?.()) throw new Error(); }
    else runHelperSync("check-file", { path: filename });
  } catch (error) { throw new VaultClientError("unsafe_location", { cause: error }); }
}
export function prepareHome(home: string) {
  privateDirectory(home);
  for (const name of ["run", "secrets", "store", "logs"]) privateDirectory(join(home, name));
}
export function privateParent(filename: string) { privateDirectory(dirname(filename)); }
