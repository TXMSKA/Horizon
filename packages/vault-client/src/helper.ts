import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VaultClientError } from "./errors.ts";
import { resolveHome } from "./paths.ts";

// Vault starts no shell. Windows Hello, DPAPI, the foreground window, private ACLs and the user Path all go through one small native helper built from packages/helper.
// A call sends its values as one JSON line on stdin and takes one JSON line back, so nothing secret reaches arguments, the environment, logs or errors.
const CAP = 64 * 1024;
type Guard<T> = (value: unknown) => value is T;
type Shape = Record<string, Guard<unknown>>;
type Infer<S extends Shape> = { [K in keyof S]: S[K] extends Guard<infer T> ? T : never };
const flag = (value: unknown): value is boolean => typeof value === "boolean";
const done = (value: unknown): value is true => value === true;
const matching = (pattern: RegExp, limit: number) => (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= limit && pattern.test(value);
const handle = matching(/^[1-9][0-9]{0,18}$/, 19), word = matching(/^[A-Za-z]{1,40}$/, 40), sentence = matching(/^[^\x00-\x1f\x7f]+$/, 256), location = matching(/^[A-Za-z]:\\[^\x00-\x1f]*$/, 4096);
const bytes = (limit: number) => matching(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, limit);
const sealed = { request: { data: bytes(22000) }, response: { data: bytes(30000) } };
const calls = {
  "hello-available": { request: {}, response: { available: flag } },
  "hello-verify": { request: { hwnd: handle, message: sentence }, response: { result: word } },
  "dpapi-protect": sealed, "dpapi-unprotect": sealed,
  "foreground-window": { request: {}, response: { hwnd: handle } },
  "protect-folder": { request: { path: location }, response: { ok: done } },
  "check-file": { request: { path: location }, response: { ok: done } },
  "user-path-add": { request: { path: location }, response: { changed: flag } },
} satisfies Record<string, { request: Shape; response: Shape }>;
export type HelperVerb = keyof typeof calls;
type Typed = { [V in HelperVerb]: { request: Infer<(typeof calls)[V]["request"]>; response: Infer<(typeof calls)[V]["response"]> } };
export type HelperRequest<V extends HelperVerb> = Typed[V]["request"];
export type HelperResponse<V extends HelperVerb> = Typed[V]["response"];
/** `timeout` is in milliseconds: 15 seconds, or 2 minutes for hello-verify, which waits for the person. */
export type HelperOptions = { timeout?: number };
const unavailable = () => new VaultClientError("unavailable");
const absolute = /^(?:[A-Za-z]:[\\/]|\/)/;
// Exactly the expected keys, each passing its check; anything else is refused.
function exact(shape: Shape, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(shape);
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && shape[key]((value as Record<string, unknown>)[key]));
}
// The "helper" field of install.json, or nothing while it is absent or names no file; a malformed one is refused.
function recorded(): string | undefined {
  let install: unknown;
  try {
    const file = openSync(join(resolveHome(), "install.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(file); if (!stat.isFile() || stat.size > 16384) return undefined;
      const text = Buffer.alloc(stat.size); readSync(file, text, 0, stat.size, 0); install = JSON.parse(text.toString("utf8"));
    } finally { closeSync(file); }
  } catch { return undefined; }
  const helper = install && typeof install === "object" ? (install as { helper?: unknown }).helper : undefined;
  if (helper === undefined) return undefined;
  if (typeof helper !== "string" || !absolute.test(helper)) throw new VaultClientError("invalid_install");
  return statSync(helper, { throwIfNoEntry: false })?.isFile() ? helper : undefined;
}
// VAULT_HELPER (tests), then the install record, then the build beside this checkout.
function executable(): string {
  const named = process.env.VAULT_HELPER;
  if (named) { if (!absolute.test(named)) throw new VaultClientError("invalid"); return named; }
  return recorded() ?? fileURLToPath(new URL("../../helper/bin/vault-helper.exe", import.meta.url));
}
function plan<V extends HelperVerb>(verb: V, request: HelperRequest<V>, options: HelperOptions) {
  if (!Object.hasOwn(calls, verb) || !exact(calls[verb].request, request)) throw new VaultClientError("invalid");
  const timeout = options.timeout ?? (verb === "hello-verify" ? 120000 : 15000);
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new VaultClientError("invalid");
  return { executable: executable(), input: Buffer.from(`${JSON.stringify(request)}\n`), timeout };
}
// One line ending in a newline, valid JSON, exactly the verb's answer keys.
function accept<V extends HelperVerb>(verb: V, output: Buffer): HelperResponse<V> {
  try {
    if (output.length < 3 || output.length > CAP || output[output.length - 1] !== 10 || output.indexOf(10) !== output.length - 1) throw unavailable();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(0, -1)));
    if (!exact(calls[verb].response, value)) throw unavailable();
    return value as HelperResponse<V>;
  } catch (error) { throw error instanceof VaultClientError ? error : unavailable(); }
  finally { output.fill(0); }
}
/** Runs one helper verb and resolves with its validated answer; any failure, timeout or odd output rejects as `unavailable`. */
export function runHelper<V extends HelperVerb>(verb: V, request: HelperRequest<V>, options: HelperOptions = {}): Promise<HelperResponse<V>> {
  return new Promise((resolve, reject) => {
    let ready: ReturnType<typeof plan<V>>;
    try { ready = plan(verb, request, options); } catch (error) { reject(error); return; }
    const child = spawn(ready.executable, [verb], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const finish = (answer: () => HelperResponse<V>) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { resolve(answer()); } catch (error) { child.kill(); reject(error instanceof VaultClientError ? error : unavailable()); }
      finally { ready.input.fill(0); for (const chunk of chunks) chunk.fill(0); }
    };
    const fail = () => finish(() => { throw unavailable(); });
    const timer = setTimeout(fail, ready.timeout);
    child.stdout.on("data", (chunk: Buffer) => { if (settled) return; chunks.push(chunk); size += chunk.length; if (size > CAP) fail(); });
    child.on("error", fail); child.stdin.on("error", fail);
    child.on("close", code => finish(() => { if (code !== 0) throw unavailable(); return accept(verb, Buffer.concat(chunks)); }));
    child.stdin.end(ready.input);
  });
}
/** The same call for code that cannot wait: the private folder and file checks. */
export function runHelperSync<V extends HelperVerb>(verb: V, request: HelperRequest<V>, options: HelperOptions = {}): HelperResponse<V> {
  const ready = plan(verb, request, options);
  try {
    const result = spawnSync(ready.executable, [verb], { shell: false, windowsHide: true, input: ready.input, stdio: ["pipe", "pipe", "ignore"], timeout: ready.timeout, maxBuffer: CAP, killSignal: "SIGKILL" });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw unavailable();
    return accept(verb, result.stdout);
  } finally { ready.input.fill(0); }
}
