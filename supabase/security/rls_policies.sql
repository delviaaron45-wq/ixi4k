-- ===========================================================================
-- ixi 4k — Políticas de Seguridad a Nivel de Fila (RLS) para Supabase
-- ===========================================================================
-- Ejecutar en el SQL Editor de tu proyecto Supabase.
--
-- OBJETIVO:
--   Solo peticiones autenticadas con JWT que porten el rol "admin"
--   pueden leer la tabla de usuarios y el Inbox de Reportes.
--   Ningún cliente puede modificar la tabla security_events (auditoría
--   inmutable) ni leer datos de otros usuarios.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Helper: ¿el JWT actual tiene rol admin?
--    (Supabase firma el token; este helper solo lee los claims verificados)
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (auth.jwt() ->> 'role') = 'admin',
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Tabla de usuarios (perfil)
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  registered_at timestamptz not null default now(),
  status        text not null default 'active' check (status in ('active','banned')),
  videos_processed int not null default 0,
  last_active   timestamptz default now()
);

alter table public.users enable row level security;

-- Admin: lectura total. Usuario: solo su propia fila.
create policy "admin_read_users" on public.users
  for select using (public.is_admin());

create policy "user_read_own_row" on public.users
  for select using (auth.uid() = id);

-- Solo el rol admin puede banear/reactivar (UPDATE) o insertar usuarios
create policy "admin_update_users" on public.users
  for update using (public.is_admin()) with check (public.is_admin());

create policy "admin_insert_users" on public.users
  for insert with check (public.is_admin());

-- Ningún cliente puede borrar usuarios desde el frontend
-- (no se crea policy de DELETE → denegado por defecto)

-- ---------------------------------------------------------------------------
-- 3. Inbox de Reportes de Usuarios
-- ---------------------------------------------------------------------------
create table if not exists public.user_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  category    text not null check (category in ('render_error','audio_sync','preview_issue','suggestion','other')),
  message     text not null,
  has_logs    boolean not null default false,
  logs        text,
  status      text not null default 'pending' check (status in ('pending','resolved')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.user_reports enable row level security;

-- Admin: bandeja completa. Usuario: solo sus propios reportes.
create policy "admin_read_reports" on public.user_reports
  for select using (public.is_admin());

create policy "user_read_own_reports" on public.user_reports
  for select using (auth.uid() = user_id);

-- Cualquier usuario autenticado puede crear su propio reporte
create policy "user_insert_own_report" on public.user_reports
  for insert with check (auth.uid() = user_id);

-- Solo admin puede cambiar estado (Resuelto) o eliminar reportes
create policy "admin_update_reports" on public.user_reports
  for update using (public.is_admin()) with check (public.is_admin());

create policy "admin_delete_reports" on public.user_reports
  for delete using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4. Registro de Auditoría (Audit Logs) — solo admin, solo inserción
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id         bigserial primary key,
  user_id    text not null,
  user_email text not null,
  action     text not null,
  details    text not null,
  type       text not null check (type in ('export','login','error','security','admin')),
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

create policy "admin_read_audit" on public.audit_logs
  for select using (public.is_admin());

-- Inserción desde el backend/service role únicamente
create policy "service_insert_audit" on public.audit_logs
  for insert with check (false);

-- Sin policies de UPDATE/DELETE → registro inmutable para clientes

-- ---------------------------------------------------------------------------
-- 5. Eventos de Seguridad (Alertas) — INMUTABLE
-- ---------------------------------------------------------------------------
create table if not exists public.security_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  user_email text not null,
  type       text not null,
  severity   text not null check (severity in ('info','warning','critical')),
  ip         text not null,
  device_id  text not null,
  details    text not null,
  created_at timestamptz not null default now()
);

alter table public.security_events enable row level security;

-- Solo admin puede visualizar las alertas
create policy "admin_read_security_events" on public.security_events
  for select using (public.is_admin());

-- Bloqueado para clientes: la inserción la realiza únicamente el
-- service role desde el backend (clave server-side nunca expuesta)
create policy "no_client_insert_security" on public.security_events
  for insert with check (false);

-- INMUTABLE: sin policies de UPDATE ni DELETE → nadie puede alterar el
-- historial de auditoría de seguridad

-- ---------------------------------------------------------------------------
-- 6. Exportaciones de vídeo (historial 4K)
-- ---------------------------------------------------------------------------
create table if not exists public.video_exports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  settings    jsonb not null,
  output_path text not null,
  created_at  timestamptz not null default now()
);

alter table public.video_exports enable row level security;

create policy "admin_read_exports" on public.video_exports
  for select using (public.is_admin());

create policy "user_read_own_exports" on public.video_exports
  for select using (auth.uid() = user_id);

create policy "user_insert_own_export" on public.video_exports
  for insert with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 7. Cómo asignar el rol Admin (claim en el JWT)
-- ---------------------------------------------------------------------------
-- Desde el Dashboard de Supabase → Authentication → Users → usuario →
-- "User Metadata" o "Raw JSON" en app_metadata:
--
--   { "role": "admin" }
--
-- Alternativa con SQL (service role):
--
--   update auth.users
--   set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb
--   where email = 'admin@ixi4k.com';
--
-- El usuario debe volver a iniciar sesión para que el nuevo claim
-- aparezca en su token JWT firmado.
-- ===========================================================================