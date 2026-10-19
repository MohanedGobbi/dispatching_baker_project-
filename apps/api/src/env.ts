// Loads apps/api/.env into process.env for tsx entry points (API, seed, scripts). Prisma's CLI reads .env on its own,
// the generated client does not. Variables already set in the environment win.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const file = join(__dirname, '..', '.env');
if (existsSync(file)) process.loadEnvFile(file);
