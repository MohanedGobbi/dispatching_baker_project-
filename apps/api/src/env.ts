// Loads apps/api/.env into process.env for tsx entry points (API, seed, scripts). Prisma's CLI reads .env on its own,
// the generated client does not. Variables already set in the environment win.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// src/env.ts under tsx, dist/src/env.js once built: apps/api/.env is one or two folders up.
const file = [join(__dirname, '..', '.env'), join(__dirname, '..', '..', '.env')].find(existsSync);
if (file) process.loadEnvFile(file);
