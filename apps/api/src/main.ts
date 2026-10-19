import 'reflect-metadata';
import './env';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { Controller, Get, Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.service';
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

@Controller()
class HealthController {
  @Public() @Get('health')
  health() { return { ok: true, service: 'crewboard-api' }; }
}

@Module({
  imports: [PrismaModule, MailModule, AuthModule, UsersModule, AuditModule, TransferModule, SettingsModule, CatalogsModule, BasesModule, EmployeesModule, UnitsModule, JobsModule, AssignmentsModule, LeaveModule, ExtensionsModule, PlanningModule, ReplacementsModule, CalendarModule, BoardModule, NotificationsModule, FilesModule, MaintenanceModule, SwapsModule, PortalModule, AnalyticsModule],
  controllers: [HealthController],
})
class AppModule {}

async function bootstrap() {
  // Uploads arrive as base64 in JSON, so the body limit is raised above the 100 kB default.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(json({ limit: "12mb" }));
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
