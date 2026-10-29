import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbHandle } from './db';
import * as t from './schema';
import type { ShopRow } from './shops';

export type UserRow = typeof t.users.$inferSelect;
export type MembershipRow = typeof t.memberships.$inferSelect;
export type Role = MembershipRow['role'];

export class AuthValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid input: ${issues.join('; ')}`);
    this.name = 'AuthValidationError';
  }
}
export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}
export class MembershipExistsError extends Error {
  constructor() {
    super('user is already a member of this shop');
    this.name = 'MembershipExistsError';
  }
}
export class LastOwnerError extends Error {
  constructor() {
    super('a shop must keep at least one owner');
    this.name = 'LastOwnerError';
  }
}
export class MembershipNotFoundError extends Error {
  constructor() {
    super('membership not found');
    this.name = 'MembershipNotFoundError';
  }
}

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const displayNameSchema = z.string().trim().min(1).max(80);
export const roleSchema = z.enum(['owner', 'manager']);
const newUserSchema = z.strictObject({ email: emailSchema, displayName: displayNameSchema });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AuthValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`));
  return r.data;
}
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE';
export const hashToken = (k: string) => createHash('sha256').update(k).digest('hex');

export const SESSION_PREFIX = 'hsu_';

/** Users, sessions and shop memberships. Password hashing is done by the caller (see apps/api auth). */
export class AuthRepository {
  readonly db: Db;
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = handle.db;
  }
  private now() {
    return this.clock().toISOString();
  }

  // ---- users ----
  createUser(input: { email: string; displayName: string }, passwordHash: string): UserRow {
    const v = parse(newUserSchema, input);
    const ts = this.now();
    const row: UserRow = { id: randomUUID(), email: v.email, displayName: v.displayName, passwordHash, createdAt: ts, updatedAt: ts };
    try {
      this.db.insert(t.users).values(row).run();
    } catch (e) {
      if (isUniqueViolation(e)) throw new EmailTakenError();
      throw e;
    }
    return row;
  }
  getUser(id: string): UserRow | undefined {
    return this.db.select().from(t.users).where(eq(t.users.id, id)).get();
  }
  /** Returns undefined for malformed emails too. */
  getUserByEmail(email: string): UserRow | undefined {
    const e = emailSchema.safeParse(email);
    return e.success ? this.db.select().from(t.users).where(eq(t.users.email, e.data)).get() : undefined;
  }

  // ---- sessions ----
  createSession(userId: string, ttlMs: number): { token: string; id: string; expiresAt: string } {
    const token = `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const expiresAt = new Date(this.clock().getTime() + ttlMs).toISOString();
    this.db.insert(t.userSessions).values({ id, userId, hashedToken: hashToken(token), createdAt: this.now(), expiresAt, revokedAt: null }).run();
    return { token, id, expiresAt };
  }
  /** Valid = exists, not revoked, not expired. */
  findSession(token: string): { sessionId: string; user: UserRow } | undefined {
    const row = this.db
      .select({ sessionId: t.userSessions.id, user: t.users })
      .from(t.userSessions)
      .innerJoin(t.users, eq(t.users.id, t.userSessions.userId))
      .where(and(eq(t.userSessions.hashedToken, hashToken(token)), isNull(t.userSessions.revokedAt), gt(t.userSessions.expiresAt, this.now())))
      .get();
    return row;
  }
  /** Deletes sessions that expired, or were revoked, more than a week ago. */
  purgeDeadSessions(): number {
    const cutoff = new Date(this.clock().getTime() - 7 * 86_400_000).toISOString();
    return this.db.delete(t.userSessions).where(or(lt(t.userSessions.expiresAt, cutoff), lt(t.userSessions.revokedAt, cutoff))).run().changes;
  }
  revokeSession(sessionId: string): void {
    this.db.update(t.userSessions).set({ revokedAt: this.now() }).where(and(eq(t.userSessions.id, sessionId), isNull(t.userSessions.revokedAt))).run();
  }

  // ---- memberships ----
  /** Creates the shop-user link. Used with ShopRepository.create inside `createShopWithOwner`. */
  addMember(shopId: string, userId: string, role: Role): MembershipRow {
    const row: MembershipRow = { id: randomUUID(), shopId, userId, role: roleSchema.parse(role), createdAt: this.now() };
    try {
      this.db.insert(t.memberships).values(row).run();
    } catch (e) {
      if (isUniqueViolation(e)) throw new MembershipExistsError();
      throw e;
    }
    return row;
  }
  getMembership(shopId: string, userId: string): MembershipRow | undefined {
    return this.db.select().from(t.memberships).where(and(eq(t.memberships.shopId, shopId), eq(t.memberships.userId, userId))).get();
  }
  /** Shops the user belongs to, with their role. */
  listShopsForUser(userId: string): Array<{ shop: ShopRow; role: Role }> {
    return this.db
      .select({ shop: t.shops, role: t.memberships.role })
      .from(t.memberships)
      .innerJoin(t.shops, eq(t.shops.id, t.memberships.shopId))
      .where(eq(t.memberships.userId, userId))
      .orderBy(asc(t.shops.createdAt), asc(t.shops.slug))
      .all();
  }
  listMembers(shopId: string): Array<{ membership: MembershipRow; user: Pick<UserRow, 'id' | 'email' | 'displayName'> }> {
    return this.db
      .select({ membership: t.memberships, user: { id: t.users.id, email: t.users.email, displayName: t.users.displayName } })
      .from(t.memberships)
      .innerJoin(t.users, eq(t.users.id, t.memberships.userId))
      .where(eq(t.memberships.shopId, shopId))
      .orderBy(asc(t.memberships.createdAt), asc(t.users.email))
      .all();
  }
  /** Atomic: refuses to demote the last owner. */
  changeRole(shopId: string, userId: string, role: Role): MembershipRow {
    roleSchema.parse(role);
    return this.handle.raw.transaction(() => {
      const m = this.getMembership(shopId, userId);
      if (!m) throw new MembershipNotFoundError();
      if (m.role === 'owner' && role !== 'owner' && this.ownerCount(shopId) <= 1) throw new LastOwnerError();
      return this.db.update(t.memberships).set({ role }).where(eq(t.memberships.id, m.id)).returning().get()!;
    })();
  }
  /** Atomic: refuses to remove the last owner. */
  removeMember(shopId: string, userId: string): void {
    this.handle.raw.transaction(() => {
      const m = this.getMembership(shopId, userId);
      if (!m) throw new MembershipNotFoundError();
      if (m.role === 'owner' && this.ownerCount(shopId) <= 1) throw new LastOwnerError();
      this.db.delete(t.memberships).where(eq(t.memberships.id, m.id)).run();
    })();
  }
  private ownerCount(shopId: string): number {
    return this.db.select().from(t.memberships).where(and(eq(t.memberships.shopId, shopId), eq(t.memberships.role, 'owner'))).all().length;
  }
}
