import { Global, Inject, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';

const MAX_ATTEMPTS = 5;

/**
 * Sends what is queued in EmailOutbox over SMTP. Without SMTP_HOST nothing is sent and emails stay queued, which is
 * how the demo runs. Configure with SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for 465), SMTP_USER, SMTP_PASS and
 * MAIL_FROM.
 */
@Injectable()
export class MailerService {
  private transport: Transporter | null = null;
  private running: Promise<{ sent: number; failed: number }> | null = null;

  constructor(@Inject(PrismaService) private prisma: PrismaService) {
    const host = process.env.SMTP_HOST;
    if (host) {
      const port = parseInt(process.env.SMTP_PORT ?? '587', 10);
      this.transport = createTransport({
        host, port, secure: process.env.SMTP_SECURE === 'true' || port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } : undefined,
      });
    }
  }

  get enabled() { return !!this.transport; }

  /** Send everything queued that has not failed too often. Concurrent calls share one run. */
  flush(): Promise<{ sent: number; failed: number }> {
    if (!this.transport) return Promise.resolve({ sent: 0, failed: 0 });
    this.running ??= this.send().finally(() => { this.running = null; });
    return this.running;
  }

  private async send() {
    const from = process.env.MAIL_FROM ?? 'CrewBoard <no-reply@crewboard.local>';
    const rows = await this.prisma.emailOutbox.findMany({ where: { sentAt: null, attempts: { lt: MAX_ATTEMPTS } }, orderBy: { createdAt: 'asc' }, take: 100 });
    let sent = 0, failed = 0;
    for (const m of rows) {
      try {
        await this.transport!.sendMail({ from, to: m.toEmail, subject: m.subject, text: m.body });
        await this.prisma.emailOutbox.update({ where: { id: m.id }, data: { sentAt: new Date(), error: null, attempts: { increment: 1 } } });
        sent++;
      } catch (e) {
        await this.prisma.emailOutbox.update({ where: { id: m.id }, data: { error: String((e as Error).message ?? e).slice(0, 500), attempts: { increment: 1 } } });
        failed++;
      }
    }
    return { sent, failed };
  }
}

@Global()
@Module({ providers: [MailerService], exports: [MailerService] })
export class MailModule implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(@Inject(MailerService) private mailer: MailerService) {}
  onModuleInit() {
    if (!this.mailer.enabled || process.env.JOBS === 'off') return;
    this.timer = setInterval(() => { this.mailer.flush().catch(e => console.error('mail sender failed', e)); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { clearInterval(this.timer); }
}
