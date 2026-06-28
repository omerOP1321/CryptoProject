-- ============================================================================
-- Supabase Auth + RBAC + About migration for the Crypto AI dashboard.
--
-- WHY: the site is a static app on Vercel. The old self-hosted Express/SQLite
-- auth server was never deployed, so login/register hit a dead URL. This moves
-- auth onto Supabase (which the dashboard already uses for prediction data), so
-- no separate backend host is needed.
--
-- HOW TO RUN: open Supabase Studio -> SQL Editor -> paste this whole file -> Run.
-- Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).
--
-- DASHBOARD CONFIG (do this too, in Supabase Studio):
--   Authentication -> Providers -> Email: ensure "Confirm email" is ON.
--   Authentication -> URL Configuration:
--     Site URL          = https://crypto-project-peach-three.vercel.app
--     Redirect URLs (add both):
--       https://crypto-project-peach-three.vercel.app/verify.html
--       https://crypto-project-peach-three.vercel.app/reset.html
--       http://localhost:8765/verify.html   (optional, for local dev)
--       http://localhost:8765/reset.html    (optional, for local dev)
-- ============================================================================

-- 1) PROFILES ----------------------------------------------------------------
-- One row per auth user. Holds the app username + RBAC role. Email, created_at,
-- last_sign_in_at and email_confirmed_at all live in auth.users and are read via
-- the SECURITY DEFINER RPCs below, so we never duplicate them here.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null,
  role       text not null default 'user' check (role in ('user','semi_admin','admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A signed-in user may read ONLY their own profile (so the app learns its role).
-- Admin listings go through admin_list_users() (SECURITY DEFINER), not RLS.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated using (id = auth.uid());
-- No insert/update/delete policies => clients cannot write profiles directly.
-- Inserts happen via the trigger; role changes via admin_set_role().

-- 2) NEW-USER TRIGGER --------------------------------------------------------
-- On signup, create the profile row, pulling the chosen username from the
-- user_metadata the client passed to signUp({ options: { data: { username } } }).
-- A duplicate username trips the UNIQUE constraint and fails the signup (backstop
-- to the client-side username_available() pre-check).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || left(new.id::text, 8)),
    'user'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) HELPERS (SECURITY DEFINER so they may read auth.users) ------------------
create or replace function public.is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = uid and role = 'admin');
$$;

-- Editing About requires an admin/semi_admin whose email is confirmed.
create or replace function public.is_editor(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = uid
      and p.role in ('admin','semi_admin')
      and u.email_confirmed_at is not null
  );
$$;

-- Is a username free? (anon-callable, for the registration form.)
create or replace function public.username_available(uname text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where username = uname);
$$;

-- Resolve a "username or email" identifier to the account email, so login can
-- call signInWithPassword (Supabase signs in by email, not username).
-- NOTE: this lets an anonymous caller map a username -> email. Acceptable for
-- this project; tighten or drop username-login if that privacy leak matters.
create or replace function public.email_for_identifier(identifier text)
returns text language plpgsql stable security definer set search_path = public as $$
declare result text;
begin
  if position('@' in identifier) > 0 then
    return lower(identifier);
  end if;
  select u.email into result
  from public.profiles p join auth.users u on u.id = p.id
  where p.username = identifier
  limit 1;
  return result;
end;
$$;

-- 4) ADMIN RPCs --------------------------------------------------------------
-- List all users (admin + semi_admin can read). Mirrors the old GET /api/users.
create or replace function public.admin_list_users()
returns table (
  id uuid, username text, email text, role text,
  email_verified boolean, created_at timestamptz, last_login_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin','semi_admin')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select p.id, p.username, u.email::text, p.role,
           (u.email_confirmed_at is not null) as email_verified,
           u.created_at, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
    order by u.created_at asc;
end;
$$;

-- Change a user's role (full admins only). Guards mirror the old user.service:
-- no changing your own role, and the last admin cannot be demoted.
create or replace function public.admin_set_role(target uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
declare admin_count int;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if new_role not in ('user','semi_admin','admin') then
    raise exception 'Invalid role';
  end if;
  if target = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  if not exists (select 1 from public.profiles where id = target) then
    raise exception 'User not found';
  end if;
  if new_role <> 'admin'
     and exists (select 1 from public.profiles where id = target and role = 'admin') then
    select count(*) into admin_count from public.profiles where role = 'admin';
    if admin_count <= 1 then
      raise exception 'Cannot demote the last admin';
    end if;
  end if;
  update public.profiles set role = new_role where id = target;
end;
$$;

-- Delete a user (full admins only). Deleting the auth.users row cascades to the
-- profile and the user's Supabase sessions. Guards: no self-delete, keep >=1 admin.
create or replace function public.admin_delete_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
declare admin_count int;
begin
  if not public.is_admin(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target = auth.uid() then
    raise exception 'You cannot delete your own account';
  end if;
  if not exists (select 1 from public.profiles where id = target) then
    raise exception 'User not found';
  end if;
  if exists (select 1 from public.profiles where id = target and role = 'admin') then
    select count(*) into admin_count from public.profiles where role = 'admin';
    if admin_count <= 1 then
      raise exception 'Cannot delete the last admin';
    end if;
  end if;
  delete from auth.users where id = target;
end;
$$;

-- 5) ABOUT CONTENT -----------------------------------------------------------
create table if not exists public.about_content (
  id         int primary key default 1 check (id = 1),
  content    text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.about_content (id, content)
values (1, '# About' || E'\n\n' || 'Edit this content from the About page as an admin.')
on conflict (id) do nothing;

alter table public.about_content enable row level security;

-- Anyone may read About; only verified editors may update it.
drop policy if exists about_read on public.about_content;
create policy about_read on public.about_content
  for select to anon, authenticated using (true);

drop policy if exists about_update on public.about_content;
create policy about_update on public.about_content
  for update to authenticated
  using (public.is_editor(auth.uid()))
  with check (public.is_editor(auth.uid()));

-- 5b) TEAM MEMBERS ----------------------------------------------------------
-- Single-row table holding the About-page team cards as a JSON array, so admins
-- can edit them from the web. Each array item is an object with free-form fields
-- (name, role, description, emoji, accent, tags, links, ...); only `name` is
-- required by the UI.
create table if not exists public.team_content (
  id         int primary key default 1 check (id = 1),
  members    jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.team_content (id, members)
values (1, '[]'::jsonb)
on conflict (id) do nothing;

alter table public.team_content enable row level security;

-- Anyone may read the team; only admins may update it.
drop policy if exists team_read on public.team_content;
create policy team_read on public.team_content
  for select to anon, authenticated using (true);

drop policy if exists team_update on public.team_content;
create policy team_update on public.team_content
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- 6) GRANTS ------------------------------------------------------------------
grant execute on function public.username_available(text)        to anon, authenticated;
grant execute on function public.email_for_identifier(text)      to anon, authenticated;
grant execute on function public.is_admin(uuid)                  to authenticated;
grant execute on function public.is_editor(uuid)                 to authenticated;
grant execute on function public.admin_list_users()              to authenticated;
grant execute on function public.admin_set_role(uuid, text)      to authenticated;
grant execute on function public.admin_delete_user(uuid)         to authenticated;

-- 7) BOOTSTRAP YOUR ADMIN ----------------------------------------------------
-- Register once on the live site, click the confirmation email, then run this
-- (replace the username) to promote yourself to full admin:
--   update public.profiles set role = 'admin' where username = 'YOUR_USERNAME';
