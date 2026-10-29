import type { FastifyBaseLogger } from 'fastify';
import type { DB } from '@secretary/db';
import type { Config } from '../config.js';
import type { KeyRing } from './crypto.js';

/** Everything services need; injected so tests can control time and storage. */
export interface Deps {
  config: Config;
  db: DB;
  keys: KeyRing;
  log: FastifyBaseLogger;
  now: () => Date;
}

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  wrappedDataKey: string;
}
