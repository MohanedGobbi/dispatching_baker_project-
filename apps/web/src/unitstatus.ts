import { ArrowRightLeft, Ban, CheckCircle2, Truck, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Severity } from './types'

/** Unit status today: label, pill severity, tile colour and icon. */
export const STATUS: Record<string, { label: string; sev: Severity; color: string; Icon: LucideIcon }> = {
  AVAILABLE: { label: 'Available', sev: 'ok', color: '#15803d', Icon: CheckCircle2 },
  DEPLOYED: { label: 'On a job', sev: 'info', color: '#1d4ed8', Icon: Truck },
  UNDER_MAINTENANCE: { label: 'In the workshop', sev: 'warn', color: '#b45309', Icon: Wrench },
  IN_TRANSIT: { label: 'In transit', sev: 'info', color: '#0e7490', Icon: ArrowRightLeft },
  OUT_OF_SERVICE: { label: 'Out of service', sev: 'bad', color: '#b91c1c', Icon: Ban },
}
