import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// English only. Components pass their English text as the default to t(), so keys never show raw.
const en = {
  app: 'CrewBoard', demo: 'Demo mode: mock data', assign: '+ Assign',
};

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false },
});

export default i18n;
