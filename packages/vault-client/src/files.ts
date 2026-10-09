import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { VaultClientError } from "./errors.ts";
export const FILE_CAP = 8 * 1024 * 1024;
export async function readCapped(filename: string, cap = FILE_CAP): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > cap) throw new VaultClientError("too_large");
    const bytes = Buffer.alloc(cap + 1); let count = 0;
    while (count <= cap) { const part = await file.read(bytes, count, bytes.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > cap) throw new VaultClientError("too_large");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); }
    finally { bytes.fill(0); }
  } finally { await file.close(); }
}
export async function atomicJson(filename: string, value: unknown) { await atomicText(filename, JSON.stringify(value)); }
export async function atomicText(filename: string, text: string, mode = 0o600) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", mode);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}
