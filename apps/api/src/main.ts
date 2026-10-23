import 'reflect-metadata';
import './env';
import { NestFactory } from '@nestjs/core';
import express, { json, NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaModule } from './prisma/prisma.service';
import { prepareDatabase } from './prisma/migrate';
import { AuthModule, Public } from './auth/auth.module';
import { SettingsModule } from './settings/settings';
import { CatalogsModule } from './catalogs/catalogs';
import { BasesModule } from './bases/bases';
import { EmployeesModule } from './employees/employees';
import { UnitsModule } from './units/units';
import { JobsModule } from './jobs/jobs';
import { AssignmentsModule } from './assignments/assignments';
import { LeaveModule } from './leave/leave';
import { ExtensionsModule } from './extensions/extensions';
import { PlanningModule } from './planning/planning';
import { ReplacementsModule } from './replacements/replacements';
import { CalendarModule } from './calendar/calendar';
import { BoardModule } from './board/board';
import { NotificationsModule } from './notifications/notifications';
import { FilesModule } from './files/files';
import { MaintenanceModule } from './maintenance/maintenance';
import { SwapsModule } from './swaps/swaps';
import { PortalModule } from './portal/portal';
import { AnalyticsModule } from './analytics/analytics';
import { MailModule } from './mail/mailer';
import { UsersModule } from './users/users';
import { AuditModule } from './audit/audit';
import { TransferModule } from './transfer/transfer';
import { FleetModule } from './fleet/fleet';
import { TasksModule } from './tasks/tasks';
import { BackupModule } from './backup/backup';

@Controller()
class HealthController {
  @Public() @Get('health')
  health() { return { ok: true, service: 'crewboard-api' }; }
}

@Module({
  imports: [PrismaModule, MailModule, AuthModule, UsersModule, AuditModule, TransferModule, FleetModule, TasksModule, SettingsModule, CatalogsModule, BasesModule, EmployeesModule, UnitsModule, JobsModule, AssignmentsModule, LeaveModule, ExtensionsModule, PlanningModule, ReplacementsModule, CalendarModule, BoardModule, NotificationsModule, FilesModule, MaintenanceModule, SwapsModule, PortalModule, AnalyticsModule, BackupModule],
  controllers: [HealthController],
})
class AppModule {}

/**
 * The built web app (apps/web/dist), when it exists, is served from the same port: requests under /api go to the API
 * with the prefix removed (what the Vite proxy does in development), everything else is a web file or index.html.
 */
function serveWeb(app: { use: (...a: unknown[]) => unknown }) {
  // Built code runs from apps/api/dist/src; under tsx (development) this path does not exist and Vite serves the web.
  const dir = process.env.WEB_DIST ?? join(__dirname, '..', '..', '..', 'web', 'dist');
  if (!existsSync(join(dir, 'index.html'))) return false;
  const files = express.static(dir, { index: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url === '/api' || req.url.startsWith('/api/')) { req.url = req.url.slice(4) || '/'; return next(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    files(req, res, () => res.sendFile(join(dir, 'index.html')));
  });
  return true;
}

async function bootstrap() {
  // Create or migrate the database before any module (timers included) can query it.
  const db = new PrismaClient();
  await prepareDatabase(db);
  await db.$disconnect();
  // Uploads arrive as base64 in JSON, so the body limit is raised above the 100 kB default.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: "12mb" }));
  const web = serveWeb(app);
  if (!web) app.enableCors(); // development: the Vite dev server calls the API from another port
  const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(`CrewBoard ${web ? 'app' : 'API'} on http://${host}:${port}`);
}
bootstrap();
