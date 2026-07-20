import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { decrypt, encrypt, hashPassword, totpCode, verifyPassword, verifyTotp } = await import('../src/lib/crypto.js');

test('password hashes verify without storing plaintext', async () => {
  const record = await hashPassword('correct horse battery staple', 'fixed-test-salt', 10_000);
  assert.notEqual(record.hash, 'correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', record.hash, record.salt, record.iterations), true);
  assert.equal(await verifyPassword('wrong password', record.hash, record.salt, record.iterations), false);
});

test('default password hashing stays within the Cloudflare Workers PBKDF2 limit', async () => {
  const record = await hashPassword('a production-strength test password', 'fixed-cloudflare-salt');
  assert.equal(record.iterations, 100_000);
  assert.equal(await verifyPassword('a production-strength test password', record.hash, record.salt, record.iterations), true);
});

test('OAuth and TOTP secrets encrypt and decrypt with AES-GCM', async () => {
  const encrypted = await encrypt('provider-access-token', 'test-encryption-key-that-is-long');
  assert.doesNotMatch(encrypted, /provider-access-token/);
  assert.equal(await decrypt(encrypted, 'test-encryption-key-that-is-long'), 'provider-access-token');
  await assert.rejects(() => decrypt(encrypted, 'wrong-key'));
});

test('TOTP matches RFC 6238 SHA-1 vector and accepts the current window', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(await totpCode(secret, 59_000, 30, 8), '94287082');
  const currentCode = await totpCode(secret, 1_234_567_890_000);
  assert.equal(await verifyTotp(secret, currentCode, 1_234_567_890_000), true);
  assert.equal(await verifyTotp(secret, '000000', 1_234_567_890_000), false);
});
