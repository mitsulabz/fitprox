import { writable, derived } from 'svelte/store';
import type { Locale } from './i18n';
import { createI18n } from './i18n';
import type { Session } from './supabase';

export type Theme = 'light' | 'dark';
export type Tab = 'suivi' | 'graph' | 'aliments' | 'amis' | 'reglages';

// Theme
const savedTheme = (localStorage.getItem('fitpro_theme') as Theme) || 'dark';
export const theme = writable<Theme>(savedTheme);
theme.subscribe(t => {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('fitpro_theme', t);
});

// Locale
const savedLocale = (localStorage.getItem('fitpro_locale') as Locale) || 'fr';
export const locale = writable<Locale>(savedLocale);
locale.subscribe(l => localStorage.setItem('fitpro_locale', l));
export const t = derived(locale, $l => createI18n($l));

// Navigation
export const activeTab = writable<Tab>('suivi');

// Auth
export const session = writable<Session | null>(null);
export const authLoading = writable(true);

// App data (état complet : jours, profil, favoris, réglages)
export const appData = writable<Record<string, unknown> | null>(null);

// Catalogue d'aliments partagé entre tous les utilisateurs (table shared_foods).
// null = indisponible (table pas encore créée, hors-ligne) -> favoris personnels seuls.
export const sharedFoods = writable<any[] | null>(null);

// Persist session in localStorage
export function persistSession(s: Session | null) {
  if (s) localStorage.setItem('fitpro_session', JSON.stringify(s));
  else localStorage.removeItem('fitpro_session');
  session.set(s);
}

export function restoreSession(): Session | null {
  try {
    const raw = localStorage.getItem('fitpro_session');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
