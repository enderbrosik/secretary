import { randomBytes } from 'node:crypto';
// Prints a new random MASTER_KEY. Store it in a secret manager; losing it makes stored credentials unrecoverable.
console.log(randomBytes(32).toString('base64'));
