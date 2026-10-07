import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VaultClientError } from "./errors.ts";
export const appIdPattern = /^[a-z][a-z0-9-]{1,39}$/;
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VAULT_HOME) return resolve(env.VAULT_HOME);
  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) throw new VaultClientError("test_default_root");
  const root = process.platform === "win32" ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(root, "Cosmic", "apps", "Vault");
}
// A background vault does not inherit app credentials or Node injection options.
export function serviceEnv(home: string): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|XDG_DATA_HOME|LANG|LC_ALL|PSMODULEPATH|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|OS)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name))), VAULT_HOME: home };
}
