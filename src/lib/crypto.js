const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PBKDF2_ITERATIONS = 100_000;

export function randomId(bytes = 18) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64Url(data);
}

export function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function sha256(value) {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

export async function hashPassword(password, salt = randomId(18), iterations = PBKDF2_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations }, material, 256);
  return { hash: toBase64Url(bits), salt, iterations };
}

export async function verifyPassword(password, expectedHash, salt, iterations) {
  const result = await hashPassword(password, salt, Number(iterations) || PBKDF2_ITERATIONS);
  return timingSafeEqual(result.hash, expectedHash);
}

export function timingSafeEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  return difference === 0;
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(String(value)));
  return `${toBase64Url(iv)}.${toBase64Url(encrypted)}`;
}

export async function decrypt(value, secret) {
  const [iv, payload] = String(value || '').split('.');
  if (!iv || !payload) throw new Error('Encrypted payload is invalid.');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) }, await encryptionKey(secret), fromBase64Url(payload));
  return decoder.decode(decrypted);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(length = 20) {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(length)));
}

export function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of String(input).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    const index = BASE32.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

export async function totpCode(secret, timestamp = Date.now(), period = 30, digits = 6) {
  let counter = BigInt(Math.floor(timestamp / 1000 / period));
  const buffer = new Uint8Array(8);
  for (let index = 7; index >= 0; index -= 1) {
    buffer[index] = Number(counter & 255n);
    counter >>= 8n;
  }
  const key = await crypto.subtle.importKey('raw', decodeBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
  const offset = signature[signature.length - 1] & 15;
  const binary = ((signature[offset] & 127) << 24) | (signature[offset + 1] << 16) | (signature[offset + 2] << 8) | signature[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

export async function verifyTotp(secret, code, timestamp = Date.now()) {
  const normalized = String(code || '').replace(/\D/g, '');
  if (normalized.length !== 6) return false;
  for (const drift of [-1, 0, 1]) {
    if (timingSafeEqual(await totpCode(secret, timestamp + drift * 30_000), normalized)) return true;
  }
  return false;
}

export function otpauthUri(secret, email, issuer = 'Multistreams.tv') {
  const label = `${issuer}:${email}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
