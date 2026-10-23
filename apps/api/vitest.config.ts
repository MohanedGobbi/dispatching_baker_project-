import { defineConfig } from 'vitest/config';

// Tests run from the TypeScript sources; dist/ holds the compiled app (npm run build).
export default defineConfig({ test: { exclude: ['dist/**', 'node_modules/**'] } });
