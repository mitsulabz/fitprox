export type Locale = 'fr' | 'en';

const fr = {
  nav: {
    suivi: 'Suivi',
    graph: 'Graph',
    aliments: 'Aliments',
    budget: 'Budget',
    amis: 'Amis',
    reglages: 'Profil',
  },
  dashboard: {
    today: "Aujourd'hui",
    deficit_day: 'Déficit du jour',
    target: 'Cible',
    in_progress: 'en cours…',
    proteins: 'Protéines',
    carbs: 'Glucides',
    fats: 'Lipides',
    cumul: 'Cumul déficit',
    since_start: 'depuis J1',
    goal_nov: 'Objectif Nov.',
    body_fat_projected: 'masse grasse projetée',
    progress: 'Progression',
  },
  auth: {
    title: 'FitProX',
    subtitle: 'Suivi nutrition & performance',
    email: 'Email',
    password: 'Mot de passe',
    signin: 'Se connecter',
    signing_in: 'Connexion…',
    error: 'Email ou mot de passe incorrect',
  },
  common: {
    kcal: 'kcal',
    g: 'g',
    kg: 'kg',
    pct: '%',
    loading: 'Chargement…',
  },
};

const en: typeof fr = {
  nav: {
    suivi: 'Dashboard',
    graph: 'Graph',
    aliments: 'Foods',
    budget: 'Budget',
    amis: 'Friends',
    reglages: 'Settings',
  },
  dashboard: {
    today: 'Today',
    deficit_day: "Today's deficit",
    target: 'Target',
    in_progress: 'in progress…',
    proteins: 'Proteins',
    carbs: 'Carbs',
    fats: 'Fats',
    cumul: 'Total deficit',
    since_start: 'since day 1',
    goal_nov: 'Goal Nov.',
    body_fat_projected: 'projected body fat',
    progress: 'Progress',
  },
  auth: {
    title: 'FitProX',
    subtitle: 'Nutrition & performance tracking',
    email: 'Email',
    password: 'Password',
    signin: 'Sign in',
    signing_in: 'Signing in…',
    error: 'Incorrect email or password',
  },
  common: {
    kcal: 'kcal',
    g: 'g',
    kg: 'kg',
    pct: '%',
    loading: 'Loading…',
  },
};

const translations = { fr, en };

export function createI18n(locale: Locale = 'fr') {
  return translations[locale];
}
