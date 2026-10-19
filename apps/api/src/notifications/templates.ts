// Notification catalog (plan section 19). English only.
// Texts are rendered when read or emailed, so a wording change applies to old notifications too.

export interface TypeDef {
  ack: boolean;     // the recipient must acknowledge (plan 19 "Needs acknowledgement")
  email: boolean;   // also emailed by default
  label: string;    // name shown in the preferences screen
}

type P = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const range = (p: P) => (p.from && p.to ? `${s(p.from)} → ${s(p.to)}` : s(p.from));

interface Entry extends TypeDef { title: (p: P) => string; body: (p: P) => string }

const e = (def: TypeDef, title: (p: P) => string, body: (p: P) => string): Entry => ({ ...def, title, body });

export const CATALOG = {
  plan_published: e(
    { ack: true, email: true, label: 'My schedule changed (plan published)' },
    () => 'New schedule published',
    p => `You have ${s(p.count)} new assignment(s). First: ${s(p.seat)}, ${range(p)}.`,
  ),
  assignment_changed: e(
    { ack: true, email: true, label: 'My assignment changed' },
    p => (p.action === 'released' ? 'You were taken off a seat' : 'Your assignment changed'),
    p => `${s(p.seat)}, ${range(p)}.`,
  ),
  crew_change_48h: e(
    { ack: false, email: false, label: 'Crew change in 48 hours' },
    () => 'Crew change coming up',
    p => `${p.role === 'incoming' ? 'You take over' : 'You hand over'} ${s(p.seat)} on ${s(p.date)}.`,
  ),
  replacement_confirmed: e(
    { ack: false, email: false, label: 'Replacement confirmed' },
    () => 'Replacement confirmed',
    p => `${s(p.incoming)} covers ${s(p.seat)}, ${range(p)}${p.outgoing ? ` (replacing ${s(p.outgoing)})` : ''}.`,
  ),
  extension_requested: e(
    { ack: false, email: false, label: 'Extension requested' },
    () => 'Extension to approve',
    p => `${s(p.employee)}: ${s(p.days)} extra day(s) on ${s(p.seat)}.`,
  ),
  extension_approved: e(
    { ack: true, email: true, label: 'My stay was extended' },
    () => 'Your stay was extended',
    p => `${s(p.days)} extra day(s) on ${s(p.seat)}, now until ${s(p.newEnd)}. Please acknowledge.`,
  ),
  leave_submitted: e(
    { ack: false, email: false, label: 'Leave request to decide' },
    () => 'Leave request waiting',
    p => `${s(p.employee)}: ${s(p.type)}, ${range(p)}.`,
  ),
  leave_decided: e(
    { ack: false, email: true, label: 'My leave request was decided' },
    p => (p.decision === 'approved' ? 'Leave approved' : 'Leave rejected'),
    p => `${s(p.type)}, ${range(p)}.${p.note ? ` ${s(p.note)}` : ''}`,
  ),
  // The type name is neutral on purpose: it says someone is unavailable, never why (plan 12.3).
  employee_unavailable: e(
    { ack: false, email: false, label: 'Someone is unavailable' },
    () => 'Employee unavailable',
    p => `${s(p.employee)} is unavailable ${range(p)}.`,
  ),
  awaiting_clearance: e(
    { ack: false, email: false, label: 'Awaiting fit-for-duty clearance' },
    () => 'Clearance needed',
    p => `${s(p.employee)} came back on ${s(p.endedOn)} and needs clearance before being assigned.`,
  ),
  restriction_changed: e(
    { ack: false, email: false, label: 'Restriction added or ended' },
    p => (p.action === 'ended' ? 'Restriction ended' : 'Restriction added'),
    p => `${p.employee ? `${s(p.employee)}: ` : ''}${s(p.kind)}${p.until ? ` until ${s(p.until)}` : ''}.`,
  ),
  task_critical: e(
    { ack: false, email: true, label: 'Critical replacement needed' },
    () => 'Critical: a seat needs someone today',
    p => `${s(p.seat)}, ${range(p)}.`,
  ),
  task_escalated: e(
    { ack: false, email: true, label: 'Replacement escalated' },
    () => 'Replacement escalated',
    p => `${s(p.seat)}, ${range(p)} has no replacement yet.`,
  ),
  base_below_min: e(
    { ack: false, email: false, label: 'Base below minimum staffing' },
    () => 'Base below minimum',
    p => `${s(p.base)}: ${s(p.position)} ${s(p.filled)} present, minimum ${s(p.min)}.`,
  ),
  unit_back: e(
    { ack: false, email: false, label: 'Unit back from maintenance' },
    () => 'Unit back from maintenance',
    p => `${s(p.unit)} is available again at ${s(p.base)}.`,
  ),
  swap_requested: e(
    { ack: false, email: false, label: 'Swap request' },
    p => (p.stage === 'manager' ? 'Swap to approve' : 'A colleague asks to swap'),
    p => `${s(p.requester)} ⇄ ${s(p.colleague)}: ${s(p.seatA)} and ${s(p.seatB)}.`,
  ),
  swap_decided: e(
    { ack: false, email: true, label: 'Swap decision' },
    p => (p.decision === 'approved' ? 'Swap approved' : p.decision === 'accepted' ? 'Swap accepted' : 'Swap declined'),
    p => s(p.note) || `${s(p.seatA)} ⇄ ${s(p.seatB)}`,
  ),
  task_assigned: e(
    { ack: false, email: true, label: 'A task was given to me' },
    () => 'New task',
    p => `${s(p.title)}${p.due ? `, by ${s(p.due)}` : ''}.`,
  ),
  task_done: e(
    { ack: false, email: false, label: 'Someone finished a task' },
    () => 'Task done',
    p => `${s(p.employee)}: ${s(p.title)}${p.note ? ` (${s(p.note)})` : ''}.`,
  ),
  broadcast: e(
    { ack: false, email: false, label: 'Messages from managers' },
    p => s(p.title),
    p => s(p.message),
  ),
} satisfies Record<string, Entry>;

export type NotificationType = keyof typeof CATALOG;
export const isType = (t: string): t is NotificationType => t in CATALOG;

export function render(type: string, payload: P): { title: string; body: string } {
  if (!isType(type)) return { title: type, body: '' };
  const entry = CATALOG[type] as Entry;
  return { title: entry.title(payload), body: entry.body(payload) };
}

export const catalogForPrefs = () =>
  (Object.entries(CATALOG) as [NotificationType, Entry][]).map(([type, d]) => ({ type, label: d.label, ack: d.ack, emailDefault: d.email }));
