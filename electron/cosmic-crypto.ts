export const PHRASE_ALGORITHM = 'QNT_PBKDF2_SHA256_AES256GCM_V1';
export const SEALED_ALGORITHM = 'QNT_AES256GCM_V1';
export const PUBLIC_ALGORITHM = 'QNT_X25519_HKDF_SHA256_AES256GCM_V1';
export interface KeyEnvelope { algorithm: string; wrapped: string }
export interface AccountKeyPair { publicKey: Uint8Array<ArrayBuffer>; privateKey: CryptoKey }

const encoder = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const invalid = () => new Error('ACCOUNT_INVALID_RESPONSE');
const bytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(value);
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function decode(envelope: KeyEnvelope, algorithm: string, minimum: number): Uint8Array<ArrayBuffer> {
  if (!envelope || envelope.algorithm !== algorithm || typeof envelope.wrapped !== 'string' || envelope.wrapped.length > 5464) throw invalid();
  const data = Buffer.from(envelope.wrapped, 'base64');
  if (data.length < minimum || data.length > 4096 || data[0] !== 1 || data.toString('base64') !== envelope.wrapped) throw invalid();
  return bytes(data);
}
function envelope(algorithm: string, data: Uint8Array): KeyEnvelope {
  if (data.length > 4096) throw invalid();
  return { algorithm, wrapped: Buffer.from(data).toString('base64') };
}
async function hkdf(material: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const key = await subtle.importKey('raw', bytes(material), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: encoder.encode(info) }, key,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function deriveKey(key: Uint8Array, info: string): Promise<CryptoKey> {
  try {
    if (key.length !== 32 || typeof info !== 'string' || !info) throw invalid();
    return await hkdf(key, new Uint8Array(), info);
  } catch { throw invalid(); }
}
export async function openPhrase(phrase: string, value: KeyEnvelope): Promise<Uint8Array<ArrayBuffer>> {
  let plain: Uint8Array<ArrayBuffer> | undefined;
  let password: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (typeof phrase !== 'string' || phrase.length > 1000) throw invalid();
    const words = phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/u);
    if (words.length !== 24 || words.some(word => !/^[a-z]+$/.test(word))) throw invalid();
    password = encoder.encode(words.join(' ')); words.fill(''); phrase = '';
    const data = decode(value, PHRASE_ALGORITHM, 1 + 16 + 12 + 16 + 32);
    if (data.length !== 77) throw invalid();
    const material = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: data.slice(1, 17), iterations: 600000 },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: data.slice(17, 29),
      additionalData: encoder.encode(PHRASE_ALGORITHM), tagLength: 128 }, key, data.slice(29)));
    if (plain.length !== 32) throw invalid();
    return plain;
  } catch { plain?.fill(0); throw new Error('ACCOUNT_PHRASE_WRONG'); }
  finally { password?.fill(0); phrase = ''; }
}
export async function openSealed(key: CryptoKey, value: KeyEnvelope, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const data = decode(value, SEALED_ALGORITHM, 1 + 12 + 16);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: data.slice(1, 13),
      additionalData: encoder.encode(aad), tagLength: 128 }, key, data.slice(13)));
  } catch { throw invalid(); }
}
export async function seal(key: CryptoKey, plain: Uint8Array, aad: string): Promise<KeyEnvelope> {
  try {
    if (plain.length > 4096 - 29) throw invalid();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: encoder.encode(aad), tagLength: 128 }, key, bytes(plain)));
    return envelope(SEALED_ALGORITHM, concat(new Uint8Array([1]), iv, encrypted));
  } catch { throw invalid(); }
}
export async function createAccountKeyPair(key: Uint8Array, accountId: string): Promise<AccountKeyPair & { envelope: KeyEnvelope }> {
  let privateBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    privateBytes = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
    const sealed = await seal(await deriveKey(key, 'cosmic/account/keypair'), privateBytes, `account-keypair:${accountId}`);
    const sealedBytes = decode(sealed, SEALED_ALGORITHM, 29);
    const value = envelope(PUBLIC_ALGORITHM, concat(new Uint8Array([1]), publicKey, sealedBytes.slice(1)));
    const privateKey = await subtle.importKey('pkcs8', privateBytes, { name: 'X25519' }, false, ['deriveBits']);
    return { publicKey, privateKey, envelope: value };
  } catch { throw invalid(); }
  finally { privateBytes?.fill(0); }
}
export async function openAccountKeyPair(key: Uint8Array, value: KeyEnvelope, accountId: string): Promise<AccountKeyPair> {
  let privateBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    const data = decode(value, PUBLIC_ALGORITHM, 33 + 12 + 16 + 1);
    const sealed = envelope(SEALED_ALGORITHM, concat(new Uint8Array([1]), data.slice(33)));
    privateBytes = await openSealed(await deriveKey(key, 'cosmic/account/keypair'), sealed, `account-keypair:${accountId}`);
    const privateKey = await subtle.importKey('pkcs8', privateBytes, { name: 'X25519' }, false, ['deriveBits']);
    return { publicKey: data.slice(1, 33), privateKey };
  } catch { throw invalid(); }
  finally { privateBytes?.fill(0); }
}
export function openPublicKey(value: KeyEnvelope): Uint8Array<ArrayBuffer> {
  try {
    // Members read only the version and the public key, whether Quantum returns the whole record or just those 33 bytes.
    const data = decode(value, PUBLIC_ALGORITHM, 33);
    return data.slice(1, 33);
  } catch { throw invalid(); }
}
async function sharedKey(privateKey: CryptoKey, ephemeral: Uint8Array, recipient: Uint8Array, peer: Uint8Array): Promise<CryptoKey> {
  let secret: Uint8Array<ArrayBuffer> | undefined;
  try {
    if (ephemeral.length !== 32 || recipient.length !== 32 || peer.length !== 32) throw invalid();
    const publicKey = await subtle.importKey('raw', bytes(peer), { name: 'X25519' }, false, []);
    secret = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256));
    return await hkdf(secret, concat(ephemeral, recipient), PUBLIC_ALGORITHM);
  } finally { secret?.fill(0); }
}
export async function wrap(publicKey: Uint8Array, plain: Uint8Array, aad: string): Promise<KeyEnvelope> {
  try {
    if (plain.length > 4096 - 61) throw invalid();
    const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
    const ephemeral = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const key = await sharedKey(pair.privateKey, ephemeral, publicKey, publicKey);
    const sealed = decode(await seal(key, plain, aad), SEALED_ALGORITHM, 29);
    return envelope(PUBLIC_ALGORITHM, concat(new Uint8Array([1]), ephemeral, sealed.slice(1)));
  } catch { throw invalid(); }
}
export async function unwrap(pair: AccountKeyPair, value: KeyEnvelope, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const data = decode(value, PUBLIC_ALGORITHM, 1 + 32 + 12 + 16);
    const ephemeral = data.slice(1, 33);
    const key = await sharedKey(pair.privateKey, ephemeral, pair.publicKey, ephemeral);
    return await openSealed(key, envelope(SEALED_ALGORITHM, concat(new Uint8Array([1]), data.slice(33))), aad);
  } catch { throw invalid(); }
}
export async function fingerprint(publicKey: Uint8Array): Promise<string> {
  try {
    if (publicKey.length !== 32) throw invalid();
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes(publicKey)));
    // The first 10 bytes in RFC 4648 base32 are exactly 16 characters, shown as 4 groups of 4.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let value = 0n;
    for (const byte of digest.subarray(0, 10)) value = value << 8n | BigInt(byte);
    const characters = Array.from({ length: 16 }, (_, index) => alphabet[Number(value >> BigInt((15 - index) * 5) & 31n)]).join('');
    return characters.match(/.{4}/g)!.join('-');
  } catch { throw invalid(); }
}
