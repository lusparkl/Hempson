import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CredentialConfigError, CredentialDecryptError, CredentialMissingError, CredentialVault, CredentialsUnavailableError, Keyring, ShopRepository, openDb, runMigrations } from '@hepson/database';

const key = () => randomBytes(32);
const setup = (ring: Keyring | null = new Keyring(1, key())) => {
  const h = openDb(':memory:');
  runMigrations(h);
  const shops = new ShopRepository(h);
  const a = shops.create({ name: 'A', slug: 'shop-a' });
  const b = shops.create({ name: 'B', slug: 'shop-b' });
  return { h, a: a.id, b: b.id, vault: new CredentialVault(h, ring) };
};
const rowOf = (h: ReturnType<typeof openDb>, shopId: string) => h.raw.prepare('select * from shop_credentials where shop_id = ?').get(shopId) as Record<string, any>;

describe('credential vault (D28)', () => {
  it('round-trips a secret, never stores plaintext, and exposes only metadata', async () => {
    const { h, a, vault } = setup();
    const secret = 'IGQVJ-super-secret-token-123';
    const meta = vault.save(a, 'instagram', secret);
    expect(meta).toMatchObject({ shopId: a, kind: 'instagram', status: 'active', keyVersion: 1 });
    expect(JSON.stringify(meta)).not.toContain(secret);
    expect(JSON.stringify(vault.get(a, 'instagram'))).not.toContain('IGQV');
    expect(await vault.withSecret(a, 'instagram', (s) => s)).toBe(secret);
    expect(vault.get(a, 'instagram')!.lastUsedAt).not.toBeNull();
    const dump = JSON.stringify(h.raw.prepare('select * from shop_credentials').all());
    expect(dump).not.toContain(secret);
    expect(Buffer.from(rowOf(h, a).ciphertext, 'base64').toString('utf8')).not.toContain('IGQV');
  });

  it('a new save overwrites the old one (same row) and reactivates', async () => {
    const { h, a, vault } = setup();
    const first = vault.save(a, 'instagram', 'one');
    vault.mark(a, 'instagram', 'needs_reconnect');
    await expect(vault.withSecret(a, 'instagram', (s) => s)).rejects.toBeInstanceOf(CredentialMissingError);
    const second = vault.save(a, 'instagram', 'two');
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ status: 'active', revokedAt: null });
    expect(second.rotatedAt).not.toBeNull();
    expect(await vault.withSecret(a, 'instagram', (s) => s)).toBe('two');
    expect(h.raw.prepare('select count(*) c from shop_credentials').get()).toEqual({ c: 1 });
  });

  it('is bound to shop, kind and row: a copied ciphertext does not decrypt', async () => {
    const { h, a, b, vault } = setup();
    vault.save(a, 'instagram', 'secret-a');
    vault.save(b, 'instagram', 'secret-b');
    const ra = rowOf(h, a);
    // copy A's sealed fields onto B's row (other shop, other row id)
    h.raw
      .prepare('update shop_credentials set wrapped_key=?, wrap_nonce=?, wrap_tag=?, nonce=?, ciphertext=?, tag=? where shop_id=?')
      .run(ra.wrapped_key, ra.wrap_nonce, ra.wrap_tag, ra.nonce, ra.ciphertext, ra.tag, b);
    await expect(vault.withSecret(b, 'instagram', (s) => s)).rejects.toBeInstanceOf(CredentialDecryptError);
    // same shop, other kind
    h.raw.prepare("update shop_credentials set kind='telegram_bot' where shop_id=?").run(a);
    await expect(vault.withSecret(a, 'telegram_bot', (s) => s)).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('detects tampering with the ciphertext', async () => {
    const { h, a, vault } = setup();
    vault.save(a, 'monobank', 'secret');
    const r = rowOf(h, a);
    const buf = Buffer.from(r.ciphertext, 'base64');
    buf[0] = buf[0]! ^ 1;
    h.raw.prepare('update shop_credentials set ciphertext=? where shop_id=?').run(buf.toString('base64'), a);
    await expect(vault.withSecret(a, 'monobank', (s) => s)).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('master-key rotation re-wraps without changing any secret and is idempotent', async () => {
    const k1 = key();
    const k2 = key();
    const { h, a, b, vault } = setup(new Keyring(1, k1));
    vault.save(a, 'instagram', 'secret-a');
    vault.save(b, 'telegram_bot', 'secret-b');
    const sealedBefore = rowOf(h, a).ciphertext;

    // rotate: new key is current, old one stays available for unwrapping
    const rotated = new CredentialVault(h, new Keyring(2, k2, [{ version: 1, key: k1 }]));
    expect(rotated.countStale()).toBe(2);
    expect(await rotated.withSecret(a, 'instagram', (s) => s)).toBe('secret-a'); // still readable before re-wrap
    expect(rotated.rewrapAll()).toEqual({ rewrapped: 2, total: 2 });
    expect(rotated.rewrapAll()).toEqual({ rewrapped: 0, total: 2 });
    expect(rowOf(h, a)).toMatchObject({ key_version: 2, ciphertext: sealedBefore }); // the sealed secret is untouched

    // old key no longer needed
    const only2 = new CredentialVault(h, new Keyring(2, k2));
    expect(await only2.withSecret(a, 'instagram', (s) => s)).toBe('secret-a');
    expect(await only2.withSecret(b, 'telegram_bot', (s) => s)).toBe('secret-b');
    // and the old key alone can no longer read them
    await expect(new CredentialVault(h, new Keyring(1, k1)).withSecret(a, 'instagram', (s) => s)).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  it('rewrap fails without changing anything when a key version is missing', () => {
    const { h, a, vault } = setup(new Keyring(1, key()));
    vault.save(a, 'instagram', 'x');
    const lost = new CredentialVault(h, new Keyring(2, key()));
    expect(() => lost.rewrapAll()).toThrow(CredentialConfigError);
    expect(rowOf(h, a).key_version).toBe(1);
  });

  it('without a master key the vault is disabled, not insecure', () => {
    const { a, vault } = setup(null);
    expect(vault.available).toBe(false);
    expect(() => vault.save(a, 'instagram', 'x')).toThrow(CredentialsUnavailableError);
    expect(vault.get(a, 'instagram')).toBeUndefined();
  });

  it('parses the keyring from the environment and rejects a bad key', () => {
    expect(Keyring.fromEnv({})).toBeNull();
    const ring = Keyring.fromEnv({ HEPSON_MASTER_KEY: key().toString('base64'), HEPSON_MASTER_KEY_VERSION: '3', HEPSON_MASTER_KEY_PREVIOUS: key().toString('base64'), HEPSON_MASTER_KEY_PREVIOUS_VERSION: '2' })!;
    expect(ring.currentVersion).toBe(3);
    expect(ring.get(2)).toBeDefined();
    expect(() => Keyring.fromEnv({ HEPSON_MASTER_KEY: 'short' })).toThrow(CredentialConfigError);
  });

  it('delete removes the secret and rejects oversize or empty input', async () => {
    const { a, vault } = setup();
    vault.save(a, 'instagram', 'x');
    expect(vault.delete(a, 'instagram')).toBe(true);
    expect(vault.get(a, 'instagram')).toBeUndefined();
    expect(() => vault.save(a, 'instagram', '')).toThrow(CredentialConfigError);
    expect(() => vault.save(a, 'instagram', 'x'.repeat(5000))).toThrow(CredentialConfigError);
  });
});
