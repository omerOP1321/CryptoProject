-- ============================================================================
-- Saved Investment Simulations (Task 6, advanced feature 5).
--
-- WHY: authenticated users can save a simulation (parameters + a server-computed
-- result summary) and revisit/compare it later. Auth already lives on Supabase
-- (see auth_setup.sql), so saved rows key straight to auth.users and RLS keeps
-- each user scoped to their own rows.
--
-- HOW TO RUN: Supabase Studio -> SQL Editor -> paste this whole file -> Run.
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
--
-- The /simulate edge function writes the `summary` itself (recomputed backend-
-- side), so a client cannot forge the saved numbers even though it owns the row.
-- ============================================================================

create table if not exists public.saved_simulations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 120),
  coin       text not null,
  params     jsonb not null,   -- { coin, initialAmount, startDate, endDate, allocation }
  summary    jsonb not null,   -- { models[], buyHold, portfolio } (curves stripped)
  created_at timestamptz not null default now()
);

create index if not exists saved_simulations_user_idx
  on public.saved_simulations (user_id, created_at desc);

alter table public.saved_simulations enable row level security;

-- Owner-only access. auth.uid() comes from the caller's JWT; the edge function
-- forwards it, so these policies apply to function calls too.
drop policy if exists saved_sim_select on public.saved_simulations;
create policy saved_sim_select on public.saved_simulations
  for select to authenticated using (user_id = auth.uid());

drop policy if exists saved_sim_insert on public.saved_simulations;
create policy saved_sim_insert on public.saved_simulations
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists saved_sim_delete on public.saved_simulations;
create policy saved_sim_delete on public.saved_simulations
  for delete to authenticated using (user_id = auth.uid());

-- No UPDATE policy: saved simulations are immutable snapshots. Re-run + re-save
-- to capture new numbers.
