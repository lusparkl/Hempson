import { randomBytes } from 'node:crypto';

// Prints a fresh 32-byte master key (D28). Put it in the environment of the API process only, NOT in the repo, the data dir or backups.
console.log(randomBytes(32).toString('base64'));
