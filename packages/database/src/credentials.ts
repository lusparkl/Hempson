import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Db, DbHandle } from './db';
import * as t from './schema';
import { CREDENTIAL_KINDS, CREDENTIAL_STATUSES } from './credential-kinds';

export { CREDENTIAL_KINDS };
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/** What may ever leave the credential layer: never the value, never any part of it. */
export type CredentialMeta = {
  id: string;
  shopId: string;
  kind: CredentialKind;
  status: CredentialStatus;
  keyVersion: number;
  createdAt: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export class CredentialConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialConfigError';
  }
}
/** No master key is configured: credential features are disabled (not insecure). */
export class CredentialsUnavailableError extends Error {
  constructor() {
    super('credential storage is disabled: HEPSON_MASTER_KEY is not set');
    this.name = 'CredentialsUnavailableError';
  }
}
export class CredentialMissingError extends Error {
  constructor() {
    super('no active credential');
    this.name = 'CredentialMissingError';
  }
}
/** The stored ciphertext does not authenticate (wrong key version/key, moved row, or tampering). */
export class CredentialDecryptError extends Error {
  constructor() {
    super('credential could not be decrypted');
    this.name = 'CredentialDecryptError';
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_SECRET_CHARS = 4096;
const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');

function parseKey(raw: string, name: string): Buffer {
  const k = Buffer.from(raw.trim(), 'base64');
  if (k.length !== KEY_BYTES) throw new CredentialConfigError(`${name} must be ${KEY_BYTES} random bytes encoded as base64`);
  return k;
}

/** Master keys by version. `current` wraps new secrets; the others only unwrap rows not yet rotated. */
export class Keyring {
  private keys = new Map<number, Buffer>();
  constructor(
    readonly currentVersion: number,
    current: Buffer,
    others: Array<{ version: number; key: Buffer }> = [],
  ) {
    if (!Number.isInteger(currentVersion) || currentVersion < 1) throw new CredentialConfigError('master key version must be a positive integer');
    if (current.length !== KEY_BYTES) throw new CredentialConfigError(`master key must be ${KEY_BYTES} bytes`);
    this.keys.set(currentVersion, current);
    for (const o of others) {
      if (o.key.length !== KEY_BYTES) throw new CredentialConfigError(`master key must be ${KEY_BYTES} bytes`);
      if (this.keys.has(o.version)) throw new CredentialConfigError('duplicate master key version');
      this.keys.set(o.version, o.key);
    }
  }
  /** `HEPSON_MASTER_KEY[_VERSION]` and, during rotation, `HEPSON_MASTER_KEY_PREVIOUS[_VERSION]`. Returns null when no master key is set. */
  static fromEnv(env: Record<string, string | undefined>): Keyring | null {
    const cur = env.HEPSON_MASTER_KEY?.trim();
    if (!cur) return null;
    const version = Number(env.HEPSON_MASTER_KEY_VERSION ?? 1);
    const others: Array<{ version: number; key: Buffer }> = [];
    const prev = env.HEPSON_MASTER_KEY_PREVIOUS?.trim();
    if (prev) others.push({ version: Number(env.HEPSON_MASTER_KEY_PREVIOUS_VERSION), key: parseKey(prev, 'HEPSON_MASTER_KEY_PREVIOUS') });
    return new Keyring(version, parseKey(cur, 'HEPSON_MASTER_KEY'), others);
  }
  get(version: number): Buffer | undefined {
    return this.keys.get(version);
  }
  get current(): Buffer {
    return this.keys.get(this.currentVersion)!;
  }
}

/** Binds a ciphertext to its shop, kind and row: copied to another row or shop it no longer authenticates. */
const aadOf = (shopId: string, kind: string, rowId: string) => Buffer.from(`hepson.cred.v1|${shopId}|${kind}|${rowId}`);

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { nonce, ciphertext, tag: c.getAuthTag() };
}
function open(key: Buffer, nonce: Buffer, ciphertext: Buffer, tag: Buffer, aad: Buffer): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ciphertext), d.final()]);
  } catch {
    throw new CredentialDecryptError();
  }
}

const toMeta = (r: typeof t.shopCredentials.$inferSelect): CredentialMeta => ({
  id: r.id,
  shopId: r.shopId,
  kind: r.kind,
  status: r.status,
  keyVersion: r.keyVersion,
  createdAt: r.createdAt,
  rotatedAt: r.rotatedAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
});

/**
 * Per-shop credential store (D28). Internal: callers authorize. There is deliberately no method that returns a stored
 * secret to a caller: `withSecret` hands the plaintext to one callback and keeps nothing.
 */
export class CredentialVault {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly keyring: Keyring | null,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }

  get available(): boolean {
    return this.keyring !== null;
  }
  private now() {
    return this.clock().toISOString();
  }
  private ring(): Keyring {
    if (!this.keyring) throw new CredentialsUnavailableError();
    return this.keyring;
  }

  private row(shopId: string, kind: CredentialKind) {
    return this.db
      .select()
      .from(t.shopCredentials)
      .where(and(eq(t.shopCredentials.shopId, shopId), eq(t.shopCredentials.kind, kind)))
      .get();
  }

  private encrypt(shopId: string, kind: CredentialKind, rowId: string, secret: string) {
    const ring = this.ring();
    const aad = aadOf(shopId, kind, rowId);
    const dataKey = randomBytes(KEY_BYTES);
    const body = seal(dataKey, Buffer.from(secret, 'utf8'), aad);
    const wrap = seal(ring.current, dataKey, aad);
    dataKey.fill(0);
    return {
      keyVersion: ring.currentVersion,
      wrappedKey: b64(wrap.ciphertext),
      wrapNonce: b64(wrap.nonce),
      wrapTag: b64(wrap.tag),
      nonce: b64(body.nonce),
      ciphertext: b64(body.ciphertext),
      tag: b64(body.tag),
    };
  }

  /** Stores (or overwrites) the shop's credential of this kind and makes it `active`. */
  save(shopId: string, kind: CredentialKind, secret: string): CredentialMeta {
    if (!CREDENTIAL_KINDS.includes(kind)) throw new CredentialConfigError('unknown credential kind');
    if (!secret || secret.length > MAX_SECRET_CHARS) throw new CredentialConfigError(`secret must be 1-${MAX_SECRET_CHARS} characters`);
    return this.handle.raw.transaction(() => {
      const ts = this.now();
      const existing = this.row(shopId, kind);
      const id = existing?.id ?? randomUUID();
      const sealed = this.encrypt(shopId, kind, id, secret);
      if (existing) {
        return toMeta(
          this.db
            .update(t.shopCredentials)
            .set({ ...sealed, status: 'active', rotatedAt: ts, revokedAt: null })
            .where(eq(t.shopCredentials.id, id))
            .returning()
            .get()!,
        );
      }
      return toMeta(this.db.insert(t.shopCredentials).values({ id, shopId, kind, status: 'active', ...sealed, createdAt: ts, rotatedAt: null, lastUsedAt: null, revokedAt: null }).returning().get());
    })();
  }

  /** Non-secret view: status and times only. Works without a master key. */
  get(shopId: string, kind: CredentialKind): CredentialMeta | undefined {
    const r = this.row(shopId, kind);
    return r && toMeta(r);
  }

  /** Runs `fn` with the plaintext of an `active` credential. The secret is not kept anywhere. */
  async withSecret<T>(shopId: string, kind: CredentialKind, fn: (secret: string) => Promise<T> | T): Promise<T> {
    const ring = this.ring();
    const r = this.row(shopId, kind);
    if (!r || r.status !== 'active') throw new CredentialMissingError();
    const key = ring.get(r.keyVersion);
    if (!key) throw new CredentialDecryptError();
    const aad = aadOf(r.shopId, r.kind, r.id);
    const dataKey = open(key, unb64(r.wrapNonce), unb64(r.wrappedKey), unb64(r.wrapTag), aad);
    let plain: Buffer;
    try {
      plain = open(dataKey, unb64(r.nonce), unb64(r.ciphertext), unb64(r.tag), aad);
    } finally {
      dataKey.fill(0);
    }
    this.db.update(t.shopCredentials).set({ lastUsedAt: this.now() }).where(eq(t.shopCredentials.id, r.id)).run();
    try {
      return await fn(plain.toString('utf8'));
    } finally {
      plain.fill(0);
    }
  }

  /** The provider rejected the credential: stop all use until the owner reconnects. Idempotent. */
  mark(shopId: string, kind: CredentialKind, status: 'revoked' | 'needs_reconnect'): CredentialMeta | undefined {
    const r = this.db
      .update(t.shopCredentials)
      .set({ status, revokedAt: this.now() })
      .where(and(eq(t.shopCredentials.shopId, shopId), eq(t.shopCredentials.kind, kind)))
      .returning()
      .get();
    return r && toMeta(r);
  }

  /** Deletes the stored secret entirely. */
  delete(shopId: string, kind: CredentialKind): boolean {
    return this.db.delete(t.shopCredentials).where(and(eq(t.shopCredentials.shopId, shopId), eq(t.shopCredentials.kind, kind))).run().changes > 0;
  }

  /** Number of rows still wrapped with a master key version other than the current one. */
  countStale(): number {
    return this.db.select({ id: t.shopCredentials.id }).from(t.shopCredentials).where(ne(t.shopCredentials.keyVersion, this.ring().currentVersion)).all().length;
  }

  /**
   * Master-key rotation: re-wraps every data key from its old master key version to the current one without touching
   * the sealed secrets. Idempotent and restartable (rows already on the current version are skipped; one transaction).
   * Throws, changing nothing, if any row needs a key version missing from the keyring.
   */
  rewrapAll(): { rewrapped: number; total: number } {
    const ring = this.ring();
    return this.handle.raw.transaction(() => {
      const rows = this.db.select().from(t.shopCredentials).all();
      let rewrapped = 0;
      for (const r of rows) {
        if (r.keyVersion === ring.currentVersion) continue;
        const old = ring.get(r.keyVersion);
        if (!old) throw new CredentialConfigError(`master key version ${r.keyVersion} is not in the keyring`);
        const aad = aadOf(r.shopId, r.kind, r.id);
        const dataKey = open(old, unb64(r.wrapNonce), unb64(r.wrappedKey), unb64(r.wrapTag), aad);
        const wrap = seal(ring.current, dataKey, aad);
        dataKey.fill(0);
        this.db
          .update(t.shopCredentials)
          .set({ keyVersion: ring.currentVersion, wrappedKey: b64(wrap.ciphertext), wrapNonce: b64(wrap.nonce), wrapTag: b64(wrap.tag) })
          .where(eq(t.shopCredentials.id, r.id))
          .run();
        rewrapped++;
      }
      return { rewrapped, total: rows.length };
    })();
  }
}
