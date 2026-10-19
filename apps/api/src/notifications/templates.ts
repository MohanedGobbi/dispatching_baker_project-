// Notification catalog (plan section 19) with its texts in English, French and Arabic.
// Texts are rendered when read or emailed, so a change of language applies to old notifications too.
export type Lang = 'en' | 'fr' | 'ar';
export const LANGS: Lang[] = ['en', 'fr', 'ar'];

export interface TypeDef {
  ack: boolean;     // the recipient must acknowledge (plan 19 "Needs acknowledgement")
  email: boolean;   // also emailed by default
  label: Record<Lang, string>; // name shown in the preferences screen
}

type P = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const range = (p: P) => (p.from && p.to ? `${s(p.from)} → ${s(p.to)}` : s(p.from));

interface Render { en: string; fr: string; ar: string }
interface Entry extends TypeDef { title: (p: P) => Render; body: (p: P) => Render }

const e = (def: Omit<Entry, 'title' | 'body'>, title: (p: P) => Render, body: (p: P) => Render): Entry => ({ ...def, title, body });

export const CATALOG = {
  plan_published: e(
    { ack: true, email: true, label: { en: 'My schedule changed (plan published)', fr: 'Mon planning a changé (plan publié)', ar: 'تغيّر جدولي (نشر خطة)' } },
    () => ({ en: 'New schedule published', fr: 'Nouveau planning publié', ar: 'تم نشر جدول جديد' }),
    p => ({
      en: `You have ${s(p.count)} new assignment(s). First: ${s(p.seat)}, ${range(p)}.`,
      fr: `Vous avez ${s(p.count)} nouvelle(s) affectation(s). Première : ${s(p.seat)}, ${range(p)}.`,
      ar: `لديك ${s(p.count)} تعيين جديد. الأول: ${s(p.seat)}، ${range(p)}.`,
    }),
  ),
  assignment_changed: e(
    { ack: true, email: true, label: { en: 'My assignment changed', fr: 'Mon affectation a changé', ar: 'تغيّر تعييني' } },
    p => ({
      en: p.action === 'released' ? 'You were taken off a seat' : 'Your assignment changed',
      fr: p.action === 'released' ? 'Vous avez été retiré d’un poste' : 'Votre affectation a changé',
      ar: p.action === 'released' ? 'تمت إزالتك من منصب' : 'تغيّر تعيينك',
    }),
    p => ({ en: `${s(p.seat)}, ${range(p)}.`, fr: `${s(p.seat)}, ${range(p)}.`, ar: `${s(p.seat)}، ${range(p)}.` }),
  ),
  crew_change_48h: e(
    { ack: false, email: false, label: { en: 'Crew change in 48 hours', fr: 'Relève dans 48 heures', ar: 'تبديل الطاقم خلال 48 ساعة' } },
    () => ({ en: 'Crew change coming up', fr: 'Relève imminente', ar: 'تبديل الطاقم قريب' }),
    p => ({
      en: `${p.role === 'incoming' ? 'You take over' : 'You hand over'} ${s(p.seat)} on ${s(p.date)}.`,
      fr: `${p.role === 'incoming' ? 'Vous prenez' : 'Vous passez'} ${s(p.seat)} le ${s(p.date)}.`,
      ar: `${p.role === 'incoming' ? 'ستتسلم' : 'ستسلّم'} ${s(p.seat)} بتاريخ ${s(p.date)}.`,
    }),
  ),
  replacement_confirmed: e(
    { ack: false, email: false, label: { en: 'Replacement confirmed', fr: 'Remplacement confirmé', ar: 'تأكيد بديل' } },
    () => ({ en: 'Replacement confirmed', fr: 'Remplacement confirmé', ar: 'تم تأكيد البديل' }),
    p => ({
      en: `${s(p.incoming)} covers ${s(p.seat)}, ${range(p)}${p.outgoing ? ` (replacing ${s(p.outgoing)})` : ''}.`,
      fr: `${s(p.incoming)} couvre ${s(p.seat)}, ${range(p)}${p.outgoing ? ` (remplace ${s(p.outgoing)})` : ''}.`,
      ar: `${s(p.incoming)} يغطي ${s(p.seat)}، ${range(p)}${p.outgoing ? ` (بدلاً من ${s(p.outgoing)})` : ''}.`,
    }),
  ),
  extension_requested: e(
    { ack: false, email: false, label: { en: 'Extension requested', fr: 'Prolongation demandée', ar: 'طلب تمديد' } },
    () => ({ en: 'Extension to approve', fr: 'Prolongation à valider', ar: 'تمديد بانتظار الموافقة' }),
    p => ({
      en: `${s(p.employee)}: ${s(p.days)} extra day(s) on ${s(p.seat)}.`,
      fr: `${s(p.employee)} : ${s(p.days)} jour(s) de plus sur ${s(p.seat)}.`,
      ar: `${s(p.employee)}: ${s(p.days)} يوم إضافي في ${s(p.seat)}.`,
    }),
  ),
  extension_approved: e(
    { ack: true, email: true, label: { en: 'My stay was extended', fr: 'Mon séjour est prolongé', ar: 'تم تمديد مدة عملي' } },
    () => ({ en: 'Your stay was extended', fr: 'Votre séjour est prolongé', ar: 'تم تمديد مدة عملك' }),
    p => ({
      en: `${s(p.days)} extra day(s) on ${s(p.seat)}, now until ${s(p.newEnd)}. Please acknowledge.`,
      fr: `${s(p.days)} jour(s) de plus sur ${s(p.seat)}, maintenant jusqu’au ${s(p.newEnd)}. Merci de confirmer.`,
      ar: `${s(p.days)} يوم إضافي في ${s(p.seat)}، حتى ${s(p.newEnd)} الآن. يرجى التأكيد.`,
    }),
  ),
  leave_submitted: e(
    { ack: false, email: false, label: { en: 'Leave request to decide', fr: 'Demande de congé à traiter', ar: 'طلب إجازة بانتظار القرار' } },
    () => ({ en: 'Leave request waiting', fr: 'Demande de congé en attente', ar: 'طلب إجازة بانتظار القرار' }),
    p => ({
      en: `${s(p.employee)}: ${s(p.type)}, ${range(p)}.`, fr: `${s(p.employee)} : ${s(p.type)}, ${range(p)}.`, ar: `${s(p.employee)}: ${s(p.type)}، ${range(p)}.`,
    }),
  ),
  leave_decided: e(
    { ack: false, email: true, label: { en: 'My leave request was decided', fr: 'Ma demande de congé a été traitée', ar: 'تم البتّ في طلب إجازتي' } },
    p => ({
      en: p.decision === 'approved' ? 'Leave approved' : 'Leave rejected', fr: p.decision === 'approved' ? 'Congé approuvé' : 'Congé refusé',
      ar: p.decision === 'approved' ? 'تمت الموافقة على الإجازة' : 'تم رفض الإجازة',
    }),
    p => ({
      en: `${s(p.type)}, ${range(p)}.${p.note ? ` ${s(p.note)}` : ''}`, fr: `${s(p.type)}, ${range(p)}.${p.note ? ` ${s(p.note)}` : ''}`, ar: `${s(p.type)}، ${range(p)}.${p.note ? ` ${s(p.note)}` : ''}`,
    }),
  ),
  // The type name is neutral on purpose: it says someone is unavailable, never why (plan 12.3).
  employee_unavailable: e(
    { ack: false, email: false, label: { en: 'Someone is unavailable', fr: 'Quelqu’un est indisponible', ar: 'شخص غير متاح' } },
    () => ({ en: 'Employee unavailable', fr: 'Employé indisponible', ar: 'موظف غير متاح' }),
    p => ({
      en: `${s(p.employee)} is unavailable ${range(p)}.`, fr: `${s(p.employee)} est indisponible ${range(p)}.`, ar: `${s(p.employee)} غير متاح ${range(p)}.`,
    }),
  ),
  awaiting_clearance: e(
    { ack: false, email: false, label: { en: 'Awaiting fit-for-duty clearance', fr: 'En attente d’aptitude', ar: 'بانتظار الإقرار باللياقة' } },
    () => ({ en: 'Clearance needed', fr: 'Aptitude à confirmer', ar: 'مطلوب إقرار اللياقة' }),
    p => ({
      en: `${s(p.employee)} came back on ${s(p.endedOn)} and needs clearance before being assigned.`,
      fr: `${s(p.employee)} est revenu le ${s(p.endedOn)} et doit être déclaré apte avant toute affectation.`,
      ar: `${s(p.employee)} عاد بتاريخ ${s(p.endedOn)} ويحتاج إقراراً باللياقة قبل التعيين.`,
    }),
  ),
  restriction_changed: e(
    { ack: false, email: false, label: { en: 'Restriction added or ended', fr: 'Restriction ajoutée ou levée', ar: 'إضافة أو إنهاء قيد' } },
    p => ({
      en: p.action === 'ended' ? 'Restriction ended' : 'Restriction added', fr: p.action === 'ended' ? 'Restriction levée' : 'Restriction ajoutée',
      ar: p.action === 'ended' ? 'انتهى القيد' : 'تمت إضافة قيد',
    }),
    p => ({
      en: `${p.employee ? `${s(p.employee)}: ` : ''}${s(p.kind)}${p.until ? ` until ${s(p.until)}` : ''}.`,
      fr: `${p.employee ? `${s(p.employee)} : ` : ''}${s(p.kind)}${p.until ? ` jusqu’au ${s(p.until)}` : ''}.`,
      ar: `${p.employee ? `${s(p.employee)}: ` : ''}${s(p.kind)}${p.until ? ` حتى ${s(p.until)}` : ''}.`,
    }),
  ),
  cert_expiring: e(
    { ack: false, email: true, label: { en: 'Certificate expiring', fr: 'Certificat bientôt expiré', ar: 'شهادة على وشك الانتهاء' } },
    p => ({ en: `Certificate expires in ${s(p.days)} days`, fr: `Certificat expire dans ${s(p.days)} jours`, ar: `تنتهي صلاحية شهادة خلال ${s(p.days)} يوماً` }),
    p => ({
      en: `${p.employee ? `${s(p.employee)}: ` : ''}${s(p.cert)} expires on ${s(p.expires)}.`,
      fr: `${p.employee ? `${s(p.employee)} : ` : ''}${s(p.cert)} expire le ${s(p.expires)}.`,
      ar: `${p.employee ? `${s(p.employee)}: ` : ''}${s(p.cert)} تنتهي في ${s(p.expires)}.`,
    }),
  ),
  task_critical: e(
    { ack: false, email: true, label: { en: 'Critical replacement needed', fr: 'Remplacement critique', ar: 'بديل عاجل مطلوب' } },
    () => ({ en: 'Critical: a seat needs someone today', fr: 'Critique : un poste doit être pourvu aujourd’hui', ar: 'عاجل: منصب يحتاج شخصاً اليوم' }),
    p => ({ en: `${s(p.seat)}, ${range(p)}.`, fr: `${s(p.seat)}, ${range(p)}.`, ar: `${s(p.seat)}، ${range(p)}.` }),
  ),
  task_escalated: e(
    { ack: false, email: true, label: { en: 'Replacement escalated', fr: 'Remplacement escaladé', ar: 'تصعيد طلب بديل' } },
    () => ({ en: 'Replacement escalated', fr: 'Remplacement escaladé', ar: 'تم تصعيد طلب بديل' }),
    p => ({ en: `${s(p.seat)}, ${range(p)} has no replacement yet.`, fr: `${s(p.seat)}, ${range(p)} : pas encore de remplaçant.`, ar: `${s(p.seat)}، ${range(p)}: لا يوجد بديل بعد.` }),
  ),
  base_below_min: e(
    { ack: false, email: false, label: { en: 'Base below minimum staffing', fr: 'Base sous l’effectif minimum', ar: 'القاعدة تحت الحد الأدنى' } },
    () => ({ en: 'Base below minimum', fr: 'Base sous le minimum', ar: 'القاعدة تحت الحد الأدنى' }),
    p => ({
      en: `${s(p.base)}: ${s(p.position)} ${s(p.filled)} present, minimum ${s(p.min)}.`,
      fr: `${s(p.base)} : ${s(p.position)} ${s(p.filled)} présent(s), minimum ${s(p.min)}.`,
      ar: `${s(p.base)}: ${s(p.position)} الحاضرون ${s(p.filled)}، الحد الأدنى ${s(p.min)}.`,
    }),
  ),
  unit_back: e(
    { ack: false, email: false, label: { en: 'Unit back from maintenance', fr: 'Unité revenue de maintenance', ar: 'عودة وحدة من الصيانة' } },
    () => ({ en: 'Unit back from maintenance', fr: 'Unité revenue de maintenance', ar: 'عادت وحدة من الصيانة' }),
    p => ({ en: `${s(p.unit)} is available again at ${s(p.base)}.`, fr: `${s(p.unit)} est de nouveau disponible à ${s(p.base)}.`, ar: `${s(p.unit)} متاحة مجدداً في ${s(p.base)}.` }),
  ),
  swap_requested: e(
    { ack: false, email: false, label: { en: 'Swap request', fr: 'Demande d’échange', ar: 'طلب تبديل' } },
    p => ({ en: p.stage === 'manager' ? 'Swap to approve' : 'A colleague asks to swap', fr: p.stage === 'manager' ? 'Échange à valider' : 'Un collègue demande un échange', ar: p.stage === 'manager' ? 'تبديل بانتظار الموافقة' : 'زميل يطلب التبديل' }),
    p => ({
      en: `${s(p.requester)} ⇄ ${s(p.colleague)}: ${s(p.seatA)} and ${s(p.seatB)}.`, fr: `${s(p.requester)} ⇄ ${s(p.colleague)} : ${s(p.seatA)} et ${s(p.seatB)}.`, ar: `${s(p.requester)} ⇄ ${s(p.colleague)}: ${s(p.seatA)} و${s(p.seatB)}.`,
    }),
  ),
  swap_decided: e(
    { ack: false, email: true, label: { en: 'Swap decision', fr: 'Décision sur l’échange', ar: 'قرار التبديل' } },
    p => ({ en: p.decision === 'approved' ? 'Swap approved' : p.decision === 'accepted' ? 'Swap accepted' : 'Swap declined', fr: p.decision === 'approved' ? 'Échange approuvé' : p.decision === 'accepted' ? 'Échange accepté' : 'Échange refusé', ar: p.decision === 'approved' ? 'تمت الموافقة على التبديل' : p.decision === 'accepted' ? 'تم قبول التبديل' : 'تم رفض التبديل' }),
    p => ({ en: s(p.note) || `${s(p.seatA)} ⇄ ${s(p.seatB)}`, fr: s(p.note) || `${s(p.seatA)} ⇄ ${s(p.seatB)}`, ar: s(p.note) || `${s(p.seatA)} ⇄ ${s(p.seatB)}` }),
  ),
  broadcast: e(
    { ack: false, email: false, label: { en: 'Messages from managers', fr: 'Messages de la direction', ar: 'رسائل من الإدارة' } },
    p => ({ en: s(p.title), fr: s(p.title), ar: s(p.title) }),
    p => ({ en: s(p.message), fr: s(p.message), ar: s(p.message) }),
  ),
} satisfies Record<string, Entry>;

export type NotificationType = keyof typeof CATALOG;
export const isType = (t: string): t is NotificationType => t in CATALOG;

export function render(type: string, payload: P, lang: Lang): { title: string; body: string } {
  if (!isType(type)) return { title: type, body: '' };
  const entry = CATALOG[type] as Entry;
  return { title: entry.title(payload)[lang], body: entry.body(payload)[lang] };
}

export const catalogForPrefs = (lang: Lang) =>
  (Object.entries(CATALOG) as [NotificationType, Entry][]).map(([type, d]) => ({ type, label: d.label[lang], ack: d.ack, emailDefault: d.email }));
