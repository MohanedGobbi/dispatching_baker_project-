// Creates the SQLite database if needed and applies new migrations (the API also does this when it starts).
import '../src/env';
import { PrismaClient } from '@prisma/client';
import { prepareDatabase, singleConnectionUrl } from '../src/prisma/migrate';

const prisma = new PrismaClient({ datasourceUrl: singleConnectionUrl() });
prepareDatabase(prisma)
  .then(() => console.log(`Database ready: ${process.env.DATABASE_URL}`))
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
