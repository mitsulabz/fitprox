-- ============================================================
--  FitProX — catalogue d'aliments PARTAGÉ entre tous les utilisateurs
--  Dashboard Supabase -> SQL Editor -> coller -> Run
--  Ré-exécutable sans risque (if not exists / drop policy if exists).
-- ============================================================

-- 1) Table : un aliment = une ligne, visible par tous les utilisateurs connectés
create table if not exists public.shared_foods (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 200),
  -- clé de dédoublonnage : même nom (casse/espaces ignorés) + même base = même aliment
  name_key    text generated always as (lower(btrim(name))) stored,
  per         text not null default '100' check (per in ('100', 'unit')),
  kcal        numeric not null default 0 check (kcal >= 0 and kcal < 20000),
  p           numeric not null default 0 check (p >= 0 and p < 2000),
  g           numeric not null default 0 check (g >= 0 and g < 2000),
  l           numeric not null default 0 check (l >= 0 and l < 2000),
  fi          numeric check (fi is null or (fi >= 0 and fi < 2000)),
  sel         numeric check (sel is null or (sel >= 0 and sel < 200)),
  -- auteur : rempli automatiquement, le client ne l'envoie jamais
  created_by  uuid default auth.uid() references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint shared_foods_unique_name unique (name_key, per)
);

-- 2) Droits : réservé aux utilisateurs connectés (aucun accès anonyme)
revoke all on public.shared_foods from anon;
grant select, insert, update, delete on public.shared_foods to authenticated;

-- 3) Sécurité au niveau ligne
alter table public.shared_foods enable row level security;

-- lecture : tout utilisateur connecté voit tout le catalogue
drop policy if exists "shared_foods_select_auth" on public.shared_foods;
create policy "shared_foods_select_auth"
  on public.shared_foods for select
  to authenticated
  using (true);

-- ajout : tout utilisateur connecté, uniquement en son propre nom
drop policy if exists "shared_foods_insert_own" on public.shared_foods;
create policy "shared_foods_insert_own"
  on public.shared_foods for insert
  to authenticated
  with check (created_by = auth.uid());

-- modification : uniquement l'auteur de l'aliment
drop policy if exists "shared_foods_update_own" on public.shared_foods;
create policy "shared_foods_update_own"
  on public.shared_foods for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

-- suppression : uniquement l'auteur (personne ne peut vider le catalogue des autres)
drop policy if exists "shared_foods_delete_own" on public.shared_foods;
create policy "shared_foods_delete_own"
  on public.shared_foods for delete
  to authenticated
  using (created_by = auth.uid());

-- 4) Diagnostic (lecture seule) : liste toutes les règles de sécurité du projet.
--    Regarde en particulier les lignes de la table app_state.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
