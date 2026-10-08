import fs from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { VaultClientError } from "./errors.ts";

// ACLs protect all service data, including ciphertext, discovery and audit records.
// A fresh descriptor carries only the owner and the access list; rewriting the one Get-Acl returns also writes the audit list, which needs a privilege users lack once the folder is protected.
// The check reads the descriptor through .NET, not Get-Acl: started from PowerShell 7, Windows PowerShell inherits its module path and Get-Acl fails to load.
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
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = "$ErrorActionPreference='Stop'; $p=$env:VAULT_PRIVATE_PATH; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r)}; (Get-Item -LiteralPath $p).SetAccessControl($acl); $a=(Get-Item -LiteralPath $p).GetAccessControl(); if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 1}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544') -or $r.AccessControlType -ne 'Allow'){exit 1}}";
    execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore", timeout: 10000, env: { ...process.env, VAULT_PRIVATE_PATH: directory } });
  } catch { throw new VaultClientError("unsafe_location"); }
}
export function privateFile(filename: string): void {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    if (process.platform !== "win32") { fs.chmodSync(filename, 0o600); if (stat.uid !== process.getuid?.()) throw new Error(); }
    else {
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = "$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=(Get-Item -LiteralPath $env:VAULT_PRIVATE_PATH).GetAccessControl(); if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 1}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544') -or $r.AccessControlType -ne 'Allow'){exit 1}}";
      execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore", timeout: 10000, env: { ...process.env, VAULT_PRIVATE_PATH: filename } });
    }
  } catch { throw new VaultClientError("unsafe_location"); }
}
export function prepareHome(home: string) {
  privateDirectory(home);
  for (const name of ["run", "secrets", "store", "logs"]) privateDirectory(join(home, name));
}
export function privateParent(filename: string) { privateDirectory(dirname(filename)); }
