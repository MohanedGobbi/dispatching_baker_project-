// Loads apps/api/.env into process.env for tsx entry points (API, seed, scripts). Prisma's CLI reads .env on its own,
// the generated client does not. Variables already set in the environment win.
// Then fills in where the data lives: DATA_DIR (default <repo>/data) holds the SQLite database and uploaded files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// src/env.ts under tsx, dist/src/env.js once built.
const apiDir = existsSync(join(__dirname, '..', 'package.json')) ? join(__dirname, '..') : join(__dirname, '..', '..');
const file = join(apiDir, '.env');
if (existsSync(file)) process.loadEnvFile(file);

const dataDir = process.env.DATA_DIR ??= join(apiDir, '..', '..', 'data');
if (!process.env.DATABASE_URL?.startsWith('file:')) process.env.DATABASE_URL = `file:${join(dataDir, 'crewboard.db')}`;
process.env.STORAGE_DIR ??= join(dataDir, 'storage');
process.env.BACKUP_DIR ??= join(dataDir, 'backups');
