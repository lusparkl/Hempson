import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectorError } from '@hepson/connector-core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stable absolute per-account Chromium user-data dir: <dataDir>/profiles/<accountUUID>. Never temp, never shared. */
export function profileDir(dataDir: string, accountId: string): string {
  if (!UUID_RE.test(accountId)) throw new ConnectorError('VALIDATION_ERROR', 'accountId must be a UUID');
  if (!path.isAbsolute(dataDir)) throw new ConnectorError('INTERNAL', 'dataDir must be absolute');
  const root = path.join(dataDir, 'profiles');
  const dir = path.join(root, accountId.toLowerCase());
  if (path.dirname(dir) !== root) throw new ConnectorError('VALIDATION_ERROR', 'invalid profile path');
  return dir;
}

export function ensureProfileDir(dir: string): void {
  mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(path.dirname(dir), 0o700);
    chmodSync(dir, 0o700);
  }
}

export function hasProfile(dir: string): boolean {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Deletes the whole profile. Only for the explicit "forget saved login" action. */
export function deleteProfile(dataDir: string, accountId: string): boolean {
  const dir = profileDir(dataDir, accountId);
  if (!existsSync(dir)) return false;
  if (lstatSync(dir).isSymbolicLink()) throw new ConnectorError('INTERNAL', 'refusing to delete a symlinked profile dir');
  rmSync(dir, { recursive: true, force: true });
  return true;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Exclusive lock per profile, stored OUTSIDE the profile dir (<dataDir>/locks/<id>.lock).
 * Stale (dead pid) locks are replaced; the profile is never touched. A live foreign pid => PROFILE_LOCKED.
 * (A reused pid can look alive; the operator then deletes the lock file by hand — profile data stays intact.)
 */
export class ProfileLock {
  private held = new Map<string, string>();
  constructor(private dataDir: string) {}
  private file(accountId: string) {
    profileDir(this.dataDir, accountId); // validates id
    return path.join(this.dataDir, 'locks', `${accountId.toLowerCase()}.lock`);
  }
  acquire(accountId: string): void {
    const f = this.file(accountId);
    if (this.held.has(accountId)) return;
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    if (existsSync(f)) {
      let pid = NaN;
      try {
        pid = JSON.parse(readFileSync(f, 'utf8')).pid;
      } catch {
        /* unreadable lock => treat as stale */
      }
      if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) throw new ConnectorError('PROFILE_LOCKED', `Profile is in use by another Hepson process (pid ${pid})`);
    }
    const token = randomUUID();
    writeFileSync(f, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { mode: 0o600 });
    this.held.set(accountId, token);
  }
  release(accountId: string): void {
    const token = this.held.get(accountId);
    if (!token) return;
    this.held.delete(accountId);
    try {
      const f = this.file(accountId);
      if (JSON.parse(readFileSync(f, 'utf8')).token === token) rmSync(f);
    } catch {
      /* already gone */
    }
  }
}
