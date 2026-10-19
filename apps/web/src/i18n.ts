import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { arPortal, frPortal } from './i18n.portal';

// English is also the default text passed to t() in the components, so a missing key never shows a raw key.
const en = {
  app: 'CrewBoard', demo: 'Demo mode: mock data', assign: '+ Assign',
};

const fr: Record<string, string> = {
  app: 'CrewBoard', demo: 'Mode démo : données fictives', assign: '+ Affecter',
  fieldView: 'Terrain', baseView: 'Personnel de base', today: "Aujourd'hui", allBases: 'Toutes les bases',
  problemsOnly: 'Problèmes seulement', liveLayer: 'En vigueur', draftPlan: 'Plan brouillon', search: 'Chercher une personne ou une unité',
  tvMode: 'Mode TV', loading: 'Chargement du tableau…', noProblems: 'Aucun problème ici.', noUnits: 'Aucune unité basée ici.',
  noStaffing: "Pas encore de modèle d'effectifs pour cette base.", vacant: 'Vide',
  kpiDeployed: 'Unités en mission', kpiAttention: 'Unités à surveiller', kpiBelowMin: 'Postes de base sous le minimum',
  kpiTasks: 'Remplacements à traiter', kpiChanges: 'Relèves dans 7 jours', critical: 'critique(s)',
  col_standby: 'Disponible', col_daysOff: 'Repos', col_leave: 'Congé', col_unavailable: 'Indisponible', col_training: 'Formation', col_awaitingClearance: "En attente d'aptitude",
  peopleNotOnSeat: "Personnes sans poste", staffOk: 'Effectif complet', staffBelowTarget: "Sous l'objectif", staffBelowMin: 'Sous le minimum', staffOffDay: "Pas nécessaire aujourd'hui",
  assignSeat: 'Affecter au poste', moveSeat: 'Déplacer vers un autre poste', from: 'Du', until: "Jusqu'au", checking: 'Vérification des règles…',
  impact: 'Ce qui se passerait', crewFilled: 'postes requis pourvus', overrideReason: 'Motif pour déroger aux règles',
  overridePlaceholder: "ex. démarrage urgent, un senior arrive le jour 3", cancel: 'Annuler', assignConfirm: 'Affecter', assignAnyway: 'Affecter quand même', proceed: 'Continuer quand même',
  swapTitle: 'Échanger ces deux personnes ?', shortened: 'Le poste est libre jusqu’au', shortenedWhy: "quelqu'un d'autre le reprend ensuite, la date de fin a donc été raccourcie.",
  historyBanner: 'Historique : voici le tableau tel qu’il était le', readOnly: 'Lecture seule.',
  draftBanner: "Calque du plan brouillon : les personnes proposées sont en pointillés. Rien n'est en vigueur avant la publication.",
  login: 'Identifiant', password: 'Mot de passe', signIn: 'Se connecter', signOut: 'Se déconnecter', demoAccounts: 'Comptes de démonstration',
  badLogin: 'Identifiant ou mot de passe incorrect', loginIntro: 'Rotations, dispatch et effectifs de base',
  nextDaysOff: 'Prochains repos', backOn: 'Reprise', next6Weeks: '6 prochaines semaines',
  portalSoon: "Le portail employé arrive bientôt. En attendant, demandez votre planning à votre dispatcher.",
};

const ar: Record<string, string> = {
  app: 'كرو بورد', demo: 'وضع تجريبي: بيانات وهمية', assign: '+ تعيين',
  fieldView: 'الميدان', baseView: 'موظفو القاعدة', today: 'اليوم', allBases: 'كل القواعد',
  problemsOnly: 'المشاكل فقط', liveLayer: 'المعتمد', draftPlan: 'خطة مسودة', search: 'ابحث عن شخص أو وحدة',
  tvMode: 'وضع الشاشة', loading: 'جارٍ تحميل اللوحة…', noProblems: 'لا توجد مشاكل هنا.', noUnits: 'لا توجد وحدات في هذه القاعدة.',
  noStaffing: 'لا يوجد قالب توظيف لهذه القاعدة بعد.', vacant: 'شاغر',
  kpiDeployed: 'وحدات في مهمة', kpiAttention: 'وحدات تحتاج انتباهاً', kpiBelowMin: 'مناصب القاعدة تحت الحد الأدنى',
  kpiTasks: 'مهام استبدال مفتوحة', kpiChanges: 'تبديل طاقم خلال 7 أيام', critical: 'حرجة',
  col_standby: 'جاهز', col_daysOff: 'راحة', col_leave: 'إجازة', col_unavailable: 'غير متاح', col_training: 'تدريب', col_awaitingClearance: 'بانتظار اللياقة',
  peopleNotOnSeat: 'أشخاص بلا منصب', staffOk: 'العدد مكتمل', staffBelowTarget: 'أقل من المستهدف', staffBelowMin: 'أقل من الحد الأدنى', staffOffDay: 'غير مطلوب اليوم',
  assignSeat: 'تعيين في المنصب', moveSeat: 'نقل إلى منصب آخر', from: 'من', until: 'إلى', checking: 'جارٍ فحص القواعد…',
  impact: 'ما الذي سيحدث', crewFilled: 'من المناصب المطلوبة مشغولة', overrideReason: 'سبب تجاوز القواعد',
  overridePlaceholder: 'مثال: بدء عاجل للمهمة، يصل أقدم في اليوم الثالث', cancel: 'إلغاء', assignConfirm: 'تعيين', assignAnyway: 'عيّن رغم ذلك', proceed: 'تابع رغم ذلك',
  swapTitle: 'تبديل هذين الشخصين؟', shortened: 'المنصب متاح حتى', shortenedWhy: 'سيتولاه شخص آخر بعد ذلك، لذلك تم تقصير تاريخ الانتهاء.',
  historyBanner: 'السجل: هكذا كانت اللوحة بتاريخ', readOnly: 'للقراءة فقط.',
  draftBanner: 'طبقة خطة المسودة: الأشخاص المقترحون بخط متقطع. لا شيء معتمد قبل نشر الخطة.',
  login: 'اسم المستخدم', password: 'كلمة المرور', signIn: 'دخول', signOut: 'خروج', demoAccounts: 'حسابات تجريبية',
  badLogin: 'اسم المستخدم أو كلمة المرور غير صحيحة', loginIntro: 'التناوب والتوزيع وتوظيف القواعد',
  nextDaysOff: 'أقرب راحة', backOn: 'العودة للعمل', next6Weeks: 'الأسابيع الستة القادمة',
  portalSoon: 'بوابة الموظف قادمة قريباً. اطلب جدولك من المُوزِّع في الوقت الحالي.',
};

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: { ...fr, ...frPortal } }, ar: { translation: { ...ar, ...arPortal } } },
  lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false },
});

export const isRtl = (lng: string) => lng === 'ar';
export default i18n;
