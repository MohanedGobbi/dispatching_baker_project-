import { ArrowRightLeft, Ban, CheckCircle2, Truck, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Severity } from './types'

/** Unit status today: label, pill severity, tile colour and icon. */
export const STATUS: Record<string, { label: string; sev: Severity; color: string; Icon: LucideIcon }> = {
  AVAILABLE: { label: 'Available', sev: 'ok', color: 'var(--pal-green-700)', Icon: CheckCircle2 },
  DEPLOYED: { label: 'On a job', sev: 'info', color: 'var(--pal-blue-700)', Icon: Truck },
  UNDER_MAINTENANCE: { label: 'In the workshop', sev: 'warn', color: 'var(--pal-amber-700)', Icon: Wrench },
  IN_TRANSIT: { label: 'In transit', sev: 'info', color: 'var(--pal-cyan-700)', Icon: ArrowRightLeft },
  OUT_OF_SERVICE: { label: 'Out of service', sev: 'bad', color: 'var(--pal-red-700)', Icon: Ban },
}
