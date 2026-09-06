/**
 * Print a fresh AUTH_SECRET.
 *
 *   node --experimental-strip-types scripts/generate-secret.ts
 */
import { randomBytes } from 'node:crypto';

console.log(`AUTH_SECRET="${randomBytes(48).toString('base64')}"`);
