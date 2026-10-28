import { deleteProfile, hasProfile, profileDir } from '@hepson/instagram-browser';
import type { AccountRow } from '@hepson/database';

/** Thin facade so the HTTP layer never touches profile bytes — only existence checks. */
export class ProfileAdmin {
  constructor(private dataDir: string) {}
  hasProfile(a: AccountRow): boolean {
    return a.connectorType === 'instagram-browser' && hasProfile(profileDir(this.dataDir, a.id));
  }
  dirFor(accountId: string) {
    return profileDir(this.dataDir, accountId);
  }
  delete(accountId: string) {
    return deleteProfile(this.dataDir, accountId);
  }
}
