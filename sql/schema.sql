-- ============================================================================
-- FOUR FLAVOURS — SUPABASE SCHEMA / UPGRADE
-- ============================================================================
-- Run this whole file in Supabase SQL Editor.
--
-- This is intentionally migration-oriented: existing products, tables, orders,
-- order_items and app_settings are preserved. The new dining_sessions layer
-- groups multiple customer ordering rounds into one final table bill.
--
-- Customer experience:
--   Scan QR -> browse -> Next -> Review -> Confirm round
--        -> Order received -> Order more (repeat as needed)
--        -> Bill -> Request bill -> staff prepares final bill -> View bill
--
-- Staff experience:
--   POS orders remain lightweight -> table sessions aggregate all rounds
--   -> customer bill request -> Prepare bill -> payment -> session closed.
--
-- IMPORTANT: never ship Supabase service_role/secret keys to the browser.
-- ============================================================================

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- Enum types
-- --------------------------------------------------------------------------

do $$
begin
  create type public.user_role as enum ('staff', 'manager', 'admin');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.order_type as enum ('dine_in', 'takeaway');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.order_source as enum ('pos', 'customer');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.order_status as enum (
    'new',
    'confirmed',
    'preparing',
    'ready',
    'served',
    'completed',
    'cancelled'
  );
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type public.payment_status as enum (
    'pending',
    'paid',
    'refunded',
    'void'
  );
exception
  when duplicate_object then null;
end $$;

-- --------------------------------------------------------------------------
-- Common updated_at trigger
-- --------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- Profiles / roles
-- --------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role public.user_role not null default 'staff',
  pin_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists pin_hash text;

create index if not exists profiles_role_idx
  on public.profiles(role);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();

-- --------------------------------------------------------------------------
-- Products
-- --------------------------------------------------------------------------

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  description text,
  category text not null default 'Uncategorized',
  price numeric(12,2) not null check (price >= 0),
  tax_exempt boolean not null default false,
  image_url text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_active_sort_idx
  on public.products(is_active, sort_order, name);

create index if not exists products_category_idx
  on public.products(category);

drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at
before update on public.products
for each row execute procedure public.set_updated_at();

-- --------------------------------------------------------------------------
-- Restaurant tables
-- --------------------------------------------------------------------------

create table if not exists public.tables (
  id uuid primary key default gen_random_uuid(),
  table_no text not null unique check (length(trim(table_no)) between 1 and 30),
  capacity integer not null default 4 check (capacity between 1 and 100),
  qr_token uuid not null unique default gen_random_uuid(),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tables_active_no_idx
  on public.tables(is_active, table_no);

drop trigger if exists tables_updated_at on public.tables;
create trigger tables_updated_at
before update on public.tables
for each row execute procedure public.set_updated_at();

-- --------------------------------------------------------------------------
-- Dining sessions: one session = one table visit / family bill
-- --------------------------------------------------------------------------

create table if not exists public.dining_sessions (
  id uuid primary key default gen_random_uuid(),
  table_id uuid references public.tables(id) on delete set null,
  session_token uuid not null unique default gen_random_uuid(),
  status text not null default 'open'
    check (status in ('open', 'bill_requested', 'bill_ready', 'closed')),

  bill_subtotal numeric(12,2),
  bill_cgst numeric(12,2),
  bill_sgst numeric(12,2),
  bill_rounding numeric(12,2),
  bill_grand_total numeric(12,2),
  bill_cgst_rate numeric(6,3),
  bill_sgst_rate numeric(6,3),

  bill_requested_at timestamptz,
  bill_ready_at timestamptz,
  closed_at timestamptz,

  payment_status public.payment_status not null default 'pending',
  payment_method text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.dining_sessions
  add column if not exists table_id uuid;

alter table public.dining_sessions
  add column if not exists session_token uuid;

alter table public.dining_sessions
  add column if not exists status text default 'open';

alter table public.dining_sessions
  add column if not exists bill_subtotal numeric(12,2);

alter table public.dining_sessions
  add column if not exists bill_cgst numeric(12,2);

alter table public.dining_sessions
  add column if not exists bill_sgst numeric(12,2);

alter table public.dining_sessions
  add column if not exists bill_rounding numeric(12,2);

alter table public.dining_sessions
  add column if not exists bill_grand_total numeric(12,2);

alter table public.dining_sessions
  add column if not exists bill_cgst_rate numeric(6,3);

alter table public.dining_sessions
  add column if not exists bill_sgst_rate numeric(6,3);

alter table public.dining_sessions
  add column if not exists bill_requested_at timestamptz;

alter table public.dining_sessions
  add column if not exists bill_ready_at timestamptz;

alter table public.dining_sessions
  add column if not exists closed_at timestamptz;

alter table public.dining_sessions
  add column if not exists payment_status public.payment_status default 'pending';

alter table public.dining_sessions
  add column if not exists payment_method text;

alter table public.dining_sessions
  add column if not exists created_at timestamptz default now();

alter table public.dining_sessions
  add column if not exists updated_at timestamptz default now();

update public.dining_sessions
set session_token = gen_random_uuid()
where session_token is null;

update public.dining_sessions
set status = 'open'
where status is null;

alter table public.dining_sessions
  alter column session_token set default gen_random_uuid();

alter table public.dining_sessions
  alter column session_token set not null;

create unique index if not exists dining_sessions_active_table_idx
  on public.dining_sessions(table_id)
  where status <> 'closed';

create index if not exists dining_sessions_status_created_idx
  on public.dining_sessions(status, created_at desc);

create index if not exists dining_sessions_table_idx
  on public.dining_sessions(table_id);

drop trigger if exists dining_sessions_updated_at on public.dining_sessions;
create trigger dining_sessions_updated_at
before update on public.dining_sessions
for each row execute procedure public.set_updated_at();

-- Protect upgraded installations where the original ALTER TABLE added the
-- columns but not the foreign-key constraints.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.dining_sessions'::regclass
      and conname = 'dining_sessions_table_id_fkey'
  ) then
    alter table public.dining_sessions
      add constraint dining_sessions_table_id_fkey
      foreign key (table_id) references public.tables(id) on delete set null;
  end if;
end $$;

create or replace function public.prevent_table_delete_with_open_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.dining_sessions
    where table_id = old.id and status <> 'closed'
  ) then
    raise exception 'Cannot delete table while its dining session is open';
  end if;
  return old;
end;
$$;

drop trigger if exists tables_prevent_delete_open_session on public.tables;
create trigger tables_prevent_delete_open_session
before delete on public.tables
for each row execute procedure public.prevent_table_delete_with_open_session();

-- --------------------------------------------------------------------------
-- Orders: individual ordering rounds inside a dining session
-- --------------------------------------------------------------------------

drop function if exists public.create_pos_order(public.order_type, uuid, jsonb, text);
drop function if exists public.place_customer_order(uuid, jsonb, text, text);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  order_type public.order_type not null,
  source public.order_source not null default 'pos',
  table_id uuid references public.tables(id) on delete set null,
  session_id uuid references public.dining_sessions(id) on delete set null,
  status public.order_status not null default 'new',
  payment_status public.payment_status not null default 'pending',
  customer_name text check (customer_name is null or length(customer_name) <= 80),
  note text check (note is null or length(note) <= 500),
  subtotal numeric(12,2) not null default 0 check (subtotal >= 0),
  cgst numeric(12,2) not null default 0 check (cgst >= 0),
  sgst numeric(12,2) not null default 0 check (sgst >= 0),
  rounding numeric(12,2) not null default 0,
  grand_total numeric(12,2) not null default 0 check (grand_total >= 0),
  cgst_rate numeric(6,3) not null default 0 check (cgst_rate between 0 and 100),
  sgst_rate numeric(6,3) not null default 0 check (sgst_rate between 0 and 100),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orders
  add column if not exists session_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_session_id_fkey'
  ) then
    alter table public.orders
      add constraint orders_session_id_fkey
      foreign key (session_id) references public.dining_sessions(id) on delete set null;
  end if;
end $$;

create index if not exists orders_created_at_idx
  on public.orders(created_at desc);

create index if not exists orders_status_created_idx
  on public.orders(status, created_at desc);

create index if not exists orders_source_created_idx
  on public.orders(source, created_at desc);

create index if not exists orders_session_created_idx
  on public.orders(session_id, created_at asc);

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at
before update on public.orders
for each row execute procedure public.set_updated_at();

-- --------------------------------------------------------------------------
-- Order items
-- --------------------------------------------------------------------------

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name_snapshot text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0 and quantity <= 1000),
  tax_exempt_snapshot boolean not null default false,
  line_total numeric(12,2)
    generated always as (round(unit_price * quantity, 2)) stored,
  created_at timestamptz not null default now()
);

alter table public.order_items
  add column if not exists tax_exempt_snapshot boolean default false;

create index if not exists order_items_order_id_idx
  on public.order_items(order_id);

-- --------------------------------------------------------------------------
-- App settings
-- --------------------------------------------------------------------------

create table if not exists public.app_settings (
  id smallint primary key default 1 check (id = 1),
  restaurant_name text not null default 'Four Flavours',
  upi_id text not null default '',
  cgst_rate numeric(6,3) not null default 2.500 check (cgst_rate between 0 and 100),
  sgst_rate numeric(6,3) not null default 2.500 check (sgst_rate between 0 and 100),
  currency_symbol text not null default '₹',
  receipt_footer text not null default 'Thank you. Visit again.',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

update public.app_settings
set restaurant_name = 'Four Flavours'
where id = 1
  and restaurant_name = 'Savrivo Restaurant';

drop trigger if exists app_settings_updated_at on public.app_settings;
create trigger app_settings_updated_at
before update on public.app_settings
for each row execute procedure public.set_updated_at();

-- --------------------------------------------------------------------------
-- Role helpers
-- --------------------------------------------------------------------------

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('staff', 'manager', 'admin')
  );
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('manager', 'admin')
  );
$$;

create or replace function public.verify_admin_pin(p_pin text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('manager', 'admin')
      and pin_hash is not null
      and pin_hash = extensions.crypt(p_pin, pin_hash)
  );
$$;

revoke all on function public.verify_admin_pin(text) from public;
grant execute on function public.verify_admin_pin(text) to authenticated;

-- --------------------------------------------------------------------------
-- Staff: get/create current table session
-- --------------------------------------------------------------------------

create or replace function public.ensure_staff_session(
  p_table_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Authenticated staff access required';
  end if;

  if not exists (
    select 1
    from public.tables
    where id = p_table_id
      and is_active = true
  ) then
    raise exception 'Invalid or inactive table';
  end if;

  select id
  into v_session_id
  from public.dining_sessions
  where table_id = p_table_id
    and status <> 'closed'
  order by created_at desc
  limit 1;

  if v_session_id is null then
    begin
      insert into public.dining_sessions(table_id, status)
      values (p_table_id, 'open')
      returning id into v_session_id;
    exception
      when unique_violation then
        select id
        into v_session_id
        from public.dining_sessions
        where table_id = p_table_id
          and status <> 'closed'
        order by created_at desc
        limit 1;
    end;
  end if;

  return v_session_id;
end;
$$;

revoke all on function public.ensure_staff_session(uuid) from public;
grant execute on function public.ensure_staff_session(uuid) to authenticated;

-- --------------------------------------------------------------------------
-- Customer: start/find one active table session
-- --------------------------------------------------------------------------

create or replace function public.ensure_customer_session(
  p_table_id uuid
)
returns table (
  session_id uuid,
  session_token uuid,
  status text,
  bill_ready_at timestamptz,
  table_no text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.dining_sessions%rowtype;
begin
  if not exists (
    select 1
    from public.tables
    where id = p_table_id
      and is_active = true
  ) then
    raise exception 'Invalid or inactive table';
  end if;

  select *
  into v_session
  from public.dining_sessions
  where table_id = p_table_id
    and status <> 'closed'
  order by created_at desc
  limit 1;

  if v_session.id is null then
    begin
      insert into public.dining_sessions(table_id, status)
      values (p_table_id, 'open')
      returning * into v_session;
    exception
      when unique_violation then
        select *
        into v_session
        from public.dining_sessions
        where table_id = p_table_id
          and status <> 'closed'
        order by created_at desc
        limit 1;
    end;
  end if;

  return query
  select
    v_session.id,
    v_session.session_token,
    v_session.status,
    v_session.bill_ready_at,
    t.table_no
  from public.tables t
  where t.id = p_table_id;
end;
$$;

revoke all on function public.ensure_customer_session(uuid) from public;
grant execute on function public.ensure_customer_session(uuid)
to anon, authenticated;

-- --------------------------------------------------------------------------
-- Customer: private session state via token; no direct order reads
-- --------------------------------------------------------------------------

create or replace function public.get_customer_session_state(
  p_table_id uuid,
  p_session_token uuid
)
returns table (
  session_id uuid,
  status text,
  bill_ready_at timestamptz,
  closed_at timestamptz,
  last_order_number bigint,
  order_count bigint,
  item_count bigint,
  orders jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.dining_sessions%rowtype;
begin
  select *
  into v_session
  from public.dining_sessions
  where table_id = p_table_id
    and session_token = p_session_token;

  if v_session.id is null then
    raise exception 'Dining session not found';
  end if;

  return query
  select
    v_session.id,
    v_session.status,
    v_session.bill_ready_at,
    v_session.closed_at,

    (
      select max(o.order_number)
      from public.orders o
      where o.session_id = v_session.id
        and o.status <> 'cancelled'
    ),

    (
      select count(*)
      from public.orders o
      where o.session_id = v_session.id
        and o.status <> 'cancelled'
    ),

    (
      select coalesce(sum(oi.quantity), 0)
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.session_id = v_session.id
        and o.status <> 'cancelled'
    ),

    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'order_number', x.order_number,
            'status', x.status,
            'created_at', x.created_at,
            'item_count', x.item_count
          )
          order by x.order_number
        )
        from (
          select
            o.order_number,
            o.status,
            o.created_at,
            coalesce(sum(oi.quantity), 0) as item_count
          from public.orders o
          left join public.order_items oi
            on oi.order_id = o.id
          where o.session_id = v_session.id
            and o.status <> 'cancelled'
          group by o.order_number, o.status, o.created_at
        ) x
      ),
      '[]'::jsonb
    );
end;
$$;

revoke all on function public.get_customer_session_state(uuid, uuid)
from public;
grant execute on function public.get_customer_session_state(uuid, uuid)
to anon, authenticated;

-- --------------------------------------------------------------------------
-- Customer order round — server authoritative pricing/tax
-- --------------------------------------------------------------------------

create or replace function public.place_customer_order(
  p_table_id uuid,
  p_session_token uuid,
  p_items jsonb,
  p_note text default null,
  p_customer_name text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  session_id uuid,
  subtotal numeric(12,2),
  cgst numeric(12,2),
  sgst numeric(12,2),
  rounding numeric(12,2),
  grand_total numeric(12,2),
  cgst_rate numeric(6,3),
  sgst_rate numeric(6,3)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.dining_sessions%rowtype;
  v_order_id uuid;
  v_order_number bigint;
  v_subtotal numeric(12,2);
  v_taxable_subtotal numeric(12,2);
  v_cgst numeric(12,2);
  v_sgst numeric(12,2);
  v_pre_round numeric(12,2);
  v_grand_total numeric(12,2);
  v_rounding numeric(12,2);
  v_cgst_rate numeric(6,3);
  v_sgst_rate numeric(6,3);
  v_requested_count integer;
  v_valid_count integer;
begin
  select *
  into v_session
  from public.dining_sessions
  where table_id = p_table_id
    and session_token = p_session_token
    and status <> 'closed'
  for update;

  if v_session.id is null then
    raise exception 'Dining session is no longer active. Scan the table QR again.';
  end if;

  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;

  select count(*)
  into v_requested_count
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  where x.quantity > 0;

  select count(*)
  into v_valid_count
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  join public.products p
    on p.id = x.product_id
   and p.is_active = true
  where x.quantity > 0;

  if v_requested_count <> v_valid_count then
    raise exception 'One or more menu items are no longer available';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity integer)
    where x.quantity > 1000
  ) then
    raise exception 'Quantity exceeds allowed limit';
  end if;

  select
    round(coalesce(sum(p.price * x.quantity), 0), 2),
    round(
      coalesce(
        sum(
          case
            when not p.tax_exempt
            then p.price * x.quantity
            else 0
          end
        ),
        0
      ),
      2
    )
  into v_subtotal, v_taxable_subtotal
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  join public.products p
    on p.id = x.product_id
  where p.is_active = true
    and x.quantity > 0;

  select cgst_rate, sgst_rate
  into v_cgst_rate, v_sgst_rate
  from public.app_settings
  where id = 1;

  v_cgst := round(v_taxable_subtotal * v_cgst_rate / 100, 2);
  v_sgst := round(v_taxable_subtotal * v_sgst_rate / 100, 2);
  v_pre_round := round(v_subtotal + v_cgst + v_sgst, 2);
  v_grand_total := round(v_pre_round);
  v_rounding := round(v_grand_total - v_pre_round, 2);

  insert into public.orders (
    order_type,
    source,
    table_id,
    session_id,
    customer_name,
    note,
    subtotal,
    cgst,
    sgst,
    rounding,
    grand_total,
    cgst_rate,
    sgst_rate
  )
  values (
    'dine_in',
    'customer',
    p_table_id,
    v_session.id,
    nullif(left(trim(p_customer_name), 80), ''),
    nullif(left(trim(p_note), 500), ''),
    v_subtotal,
    v_cgst,
    v_sgst,
    v_rounding,
    v_grand_total,
    v_cgst_rate,
    v_sgst_rate
  )
  returning id, order_number into v_order_id, v_order_number;

  insert into public.order_items (
    order_id,
    product_id,
    name_snapshot,
    unit_price,
    quantity,
    tax_exempt_snapshot
  )
  select
    v_order_id,
    p.id,
    p.name,
    p.price,
    x.quantity,
    p.tax_exempt
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  join public.products p
    on p.id = x.product_id
  where p.is_active = true
    and x.quantity > 0;

  -- If a table had previously requested/prepared a bill and decides to order
  -- more, the same session is reopened and its final-bill snapshot is cleared.
  update public.dining_sessions
  set
    status = 'open',
    bill_requested_at = null,
    bill_ready_at = null,
    bill_subtotal = null,
    bill_cgst = null,
    bill_sgst = null,
    bill_rounding = null,
    bill_grand_total = null,
    bill_cgst_rate = null,
    bill_sgst_rate = null,
    payment_status = 'pending',
    payment_method = null
  where id = v_session.id;

  return query
  select
    v_order_id,
    v_order_number,
    v_session.id,
    v_subtotal,
    v_cgst,
    v_sgst,
    v_rounding,
    v_grand_total,
    v_cgst_rate,
    v_sgst_rate;
end;
$$;

revoke all on function public.place_customer_order(
  uuid, uuid, jsonb, text, text
) from public;

grant execute on function public.place_customer_order(
  uuid, uuid, jsonb, text, text
) to anon, authenticated;

-- --------------------------------------------------------------------------
-- Staff POS round creation
-- --------------------------------------------------------------------------

create or replace function public.create_pos_order(
  p_order_type public.order_type,
  p_table_id uuid,
  p_items jsonb,
  p_note text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  session_id uuid,
  subtotal numeric(12,2),
  cgst numeric(12,2),
  sgst numeric(12,2),
  rounding numeric(12,2),
  grand_total numeric(12,2),
  cgst_rate numeric(6,3),
  sgst_rate numeric(6,3)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_order_id uuid;
  v_order_number bigint;
  v_subtotal numeric(12,2);
  v_taxable_subtotal numeric(12,2);
  v_cgst numeric(12,2);
  v_sgst numeric(12,2);
  v_pre_round numeric(12,2);
  v_grand_total numeric(12,2);
  v_rounding numeric(12,2);
  v_cgst_rate numeric(6,3);
  v_sgst_rate numeric(6,3);
  v_requested_count integer;
  v_valid_count integer;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Authenticated staff access required';
  end if;

  if p_order_type = 'dine_in' then
    if p_table_id is null then
      raise exception 'Dine-in orders require a table';
    end if;
    v_session_id = public.ensure_staff_session(p_table_id);
  end if;

  if p_order_type = 'takeaway' and p_table_id is not null then
    raise exception 'Takeaway orders cannot have a table';
  end if;

  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item';
  end if;

  select count(*)
  into v_requested_count
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  where x.quantity > 0;

  select count(*)
  into v_valid_count
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  join public.products p
    on p.id = x.product_id
   and p.is_active = true
  where x.quantity > 0;

  if v_requested_count <> v_valid_count then
    raise exception 'One or more menu items are no longer available';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity integer)
    where x.quantity > 1000
  ) then
    raise exception 'Quantity exceeds allowed limit';
  end if;

  select
    round(coalesce(sum(p.price * x.quantity), 0), 2),
    round(
      coalesce(
        sum(
          case
            when not p.tax_exempt
            then p.price * x.quantity
            else 0
          end
        ),
        0
      ),
      2
    )
  into v_subtotal, v_taxable_subtotal
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  join public.products p
    on p.id = x.product_id
  where p.is_active = true
    and x.quantity > 0;

  select cgst_rate, sgst_rate
  into v_cgst_rate, v_sgst_rate
  from public.app_settings
  where id = 1;

  v_cgst := round(v_taxable_subtotal * v_cgst_rate / 100, 2);
  v_sgst := round(v_taxable_subtotal * v_sgst_rate / 100, 2);
  v_pre_round := round(v_subtotal + v_cgst + v_sgst, 2);
  v_grand_total := round(v_pre_round);
  v_rounding := round(v_grand_total - v_pre_round, 2);

  insert into public.orders (
    order_type,
    source,
    table_id,
    session_id,
    note,
    subtotal,
    cgst,
    sgst,
    rounding,
    grand_total,
    cgst_rate,
    sgst_rate,
    created_by
  )
  values (
    p_order_type,
    'pos',
    p_table_id,
    v_session_id,
    nullif(left(trim(p_note), 500), ''),
    v_subtotal,
    v_cgst,
    v_sgst,
    v_rounding,
    v_grand_total,
    v_cgst_rate,
    v_sgst_rate,
    auth.uid()
  )
  returning id, order_number into v_order_id, v_order_number;

  insert into public.order_items (
    order_id,
    product_id,
    name_snapshot,
    unit_price,
    quantity,
    tax_exempt_snapshot
  )
  select
    v_order_id,
    p.id,
    p.name,
    p.price,
    x.quantity,
    p.tax_exempt
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity integer)
  join public.products p
    on p.id = x.product_id
  where p.is_active = true
    and x.quantity > 0;

  if v_session_id is not null then
    update public.dining_sessions
    set
      status = 'open',
      bill_requested_at = null,
      bill_ready_at = null,
      bill_subtotal = null,
      bill_cgst = null,
      bill_sgst = null,
      bill_rounding = null,
      bill_grand_total = null,
      bill_cgst_rate = null,
      bill_sgst_rate = null,
      payment_status = 'pending',
      payment_method = null
    where id = v_session_id;
  end if;

  return query
  select
    v_order_id,
    v_order_number,
    v_session_id,
    v_subtotal,
    v_cgst,
    v_sgst,
    v_rounding,
    v_grand_total,
    v_cgst_rate,
    v_sgst_rate;
end;
$$;

revoke all on function public.create_pos_order(
  public.order_type, uuid, jsonb, text
) from public;

grant execute on function public.create_pos_order(
  public.order_type, uuid, jsonb, text
) to authenticated;

-- --------------------------------------------------------------------------
-- Customer requests final bill
-- --------------------------------------------------------------------------

create or replace function public.request_session_bill(
  p_table_id uuid,
  p_session_token uuid
)
returns table (
  session_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id
  into v_id
  from public.dining_sessions
  where table_id = p_table_id
    and session_token = p_session_token
    and status = 'open'
  for update;

  if v_id is null then
    raise exception 'This dining session cannot request a bill right now';
  end if;

  if not exists (
    select 1
    from public.orders
    where session_id = v_id
      and status <> 'cancelled'
  ) then
    raise exception 'There are no orders on this table yet';
  end if;

  update public.dining_sessions
  set
    status = 'bill_requested',
    bill_requested_at = now()
  where id = v_id;

  return query
  select v_id, 'bill_requested'::text;
end;
$$;

revoke all on function public.request_session_bill(uuid, uuid)
from public;

grant execute on function public.request_session_bill(uuid, uuid)
to anon, authenticated;

-- --------------------------------------------------------------------------
-- Staff prepares one consolidated final bill
-- --------------------------------------------------------------------------

create or replace function public.mark_session_bill_ready(
  p_session_id uuid
)
returns table (
  session_id uuid,
  status text,
  subtotal numeric(12,2),
  cgst numeric(12,2),
  sgst numeric(12,2),
  rounding numeric(12,2),
  grand_total numeric(12,2),
  cgst_rate numeric(6,3),
  sgst_rate numeric(6,3)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal numeric(12,2);
  v_cgst numeric(12,2);
  v_sgst numeric(12,2);
  v_pre_round numeric(12,2);
  v_rounding numeric(12,2);
  v_grand_total numeric(12,2);
  v_cgst_rate numeric(6,3);
  v_sgst_rate numeric(6,3);
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Authenticated staff access required';
  end if;

  perform 1
  from public.dining_sessions
  where id = p_session_id
    and status in ('open', 'bill_requested')
  for update;

  if not found then
    raise exception 'Dining session is not available for billing';
  end if;

  select
    round(coalesce(sum(o.subtotal), 0), 2),
    round(coalesce(sum(o.cgst), 0), 2),
    round(coalesce(sum(o.sgst), 0), 2)
  into v_subtotal, v_cgst, v_sgst
  from public.orders o
  where o.session_id = p_session_id
    and o.status <> 'cancelled';

  if v_subtotal <= 0 then
    raise exception 'No billable orders were found';
  end if;

  -- All rounds should normally share one tax configuration. Use the weighted
  -- line-count-independent average for display if configuration changed mid-visit.
  select
    coalesce(round(avg(o.cgst_rate), 3), 0),
    coalesce(round(avg(o.sgst_rate), 3), 0)
  into v_cgst_rate, v_sgst_rate
  from public.orders o
  where o.session_id = p_session_id
    and o.status <> 'cancelled';

  -- The authoritative session total is rounded once, after all rounds are
  -- consolidated. This prevents three separate bills from rounding separately.
  v_pre_round := round(v_subtotal + v_cgst + v_sgst, 2);
  v_grand_total := round(v_pre_round);
  v_rounding := round(v_grand_total - v_pre_round, 2);

  update public.dining_sessions
  set
    status = 'bill_ready',
    bill_ready_at = now(),
    bill_subtotal = v_subtotal,
    bill_cgst = v_cgst,
    bill_sgst = v_sgst,
    bill_rounding = v_rounding,
    bill_grand_total = v_grand_total,
    bill_cgst_rate = v_cgst_rate,
    bill_sgst_rate = v_sgst_rate
  where id = p_session_id;

  return query
  select
    p_session_id,
    'bill_ready'::text,
    v_subtotal,
    v_cgst,
    v_sgst,
    v_rounding,
    v_grand_total,
    v_cgst_rate,
    v_sgst_rate;
end;
$$;

revoke all on function public.mark_session_bill_ready(uuid)
from public;

grant execute on function public.mark_session_bill_ready(uuid)
to authenticated;

-- --------------------------------------------------------------------------
-- Customer may read final bill ONLY when staff has prepared it
-- --------------------------------------------------------------------------

create or replace function public.get_customer_session_bill(
  p_table_id uuid,
  p_session_token uuid
)
returns table (
  session_id uuid,
  table_no text,
  subtotal numeric(12,2),
  cgst numeric(12,2),
  sgst numeric(12,2),
  rounding numeric(12,2),
  grand_total numeric(12,2),
  cgst_rate numeric(6,3),
  sgst_rate numeric(6,3),
  orders jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.dining_sessions%rowtype;
  v_orders jsonb;
  v_table_no text;
begin
  select *
  into v_session
  from public.dining_sessions
  where table_id = p_table_id
    and session_token = p_session_token;

  if v_session.id is null then
    raise exception 'Dining session not found';
  end if;

  if v_session.status not in ('bill_ready', 'closed') then
    raise exception 'The final bill is not ready yet';
  end if;

  select table_no
  into v_table_no
  from public.tables
  where id = p_table_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'order_number', x.order_number,
        'created_at', x.created_at,
        'items', x.items
      )
      order by x.order_number
    ),
    '[]'::jsonb
  )
  into v_orders
  from (
    select
      o.order_number,
      o.created_at,
      jsonb_agg(
        jsonb_build_object(
          'name', oi.name_snapshot,
          'quantity', oi.quantity,
          'unit_price', oi.unit_price,
          'line_total', oi.line_total
        )
        order by oi.id
      ) as items
    from public.orders o
    join public.order_items oi
      on oi.order_id = o.id
    where o.session_id = v_session.id
      and o.status <> 'cancelled'
    group by o.order_number, o.created_at
  ) x;

  return query
  select
    v_session.id,
    v_table_no,
    v_session.bill_subtotal,
    v_session.bill_cgst,
    v_session.bill_sgst,
    v_session.bill_rounding,
    v_session.bill_grand_total,
    v_session.bill_cgst_rate,
    v_session.bill_sgst_rate,
    v_orders;
end;
$$;

revoke all on function public.get_customer_session_bill(uuid, uuid)
from public;

grant execute on function public.get_customer_session_bill(uuid, uuid)
to anon, authenticated;

-- --------------------------------------------------------------------------
-- Staff settles final bill and closes the visit
-- --------------------------------------------------------------------------

create or replace function public.complete_session_payment(
  p_session_id uuid,
  p_payment_method text
)
returns table (
  session_id uuid,
  status text,
  payment_status public.payment_status,
  payment_method text,
  grand_total numeric(12,2)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric(12,2);
  v_method text;
begin
  if auth.uid() is null or not public.is_staff() then
    raise exception 'Authenticated staff access required';
  end if;

  v_method = lower(trim(p_payment_method));

  if v_method not in ('cash', 'upi', 'card') then
    raise exception 'Unsupported payment method';
  end if;

  select bill_grand_total
  into v_total
  from public.dining_sessions
  where id = p_session_id
    and status = 'bill_ready'
  for update;

  if v_total is null then
    raise exception 'The final bill must be prepared before payment';
  end if;

  update public.dining_sessions
  set
    status = 'closed',
    payment_status = 'paid',
    payment_method = v_method,
    closed_at = now()
  where id = p_session_id;

  update public.orders
  set
    status = 'completed',
    payment_status = 'paid'
  where session_id = p_session_id
    and status <> 'cancelled';

  return query
  select
    p_session_id,
    'closed'::text,
    'paid'::public.payment_status,
    v_method,
    v_total;
end;
$$;

revoke all on function public.complete_session_payment(uuid, text)
from public;

grant execute on function public.complete_session_payment(uuid, text)
to authenticated;

-- --------------------------------------------------------------------------
-- Row Level Security
-- --------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.tables enable row level security;
alter table public.dining_sessions enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.app_settings enable row level security;

-- Profiles: users only read themselves.
drop policy if exists "profiles self select" on public.profiles;
create policy "profiles self select"
on public.profiles
for select to authenticated
using ((select auth.uid()) = id);

-- Products: customer receives active menu only. Managers also see inactive.
drop policy if exists "public active menu read" on public.products;
create policy "public active menu read"
on public.products
for select to anon, authenticated
using (is_active or public.is_manager());

drop policy if exists "manager product insert" on public.products;
create policy "manager product insert"
on public.products
for insert to authenticated
with check (public.is_manager());

drop policy if exists "manager product update" on public.products;
create policy "manager product update"
on public.products
for update to authenticated
using (public.is_manager())
with check (public.is_manager());

drop policy if exists "manager product delete" on public.products;
create policy "manager product delete"
on public.products
for delete to authenticated
using (public.is_manager());

-- Tables: customer receives only the active table necessary for QR flow.
drop policy if exists "public active table read" on public.tables;
create policy "public active table read"
on public.tables
for select to anon, authenticated
using (is_active or public.is_manager());

drop policy if exists "manager table insert" on public.tables;
create policy "manager table insert"
on public.tables
for insert to authenticated
with check (public.is_manager());

drop policy if exists "manager table update" on public.tables;
create policy "manager table update"
on public.tables
for update to authenticated
using (public.is_manager())
with check (public.is_manager());

drop policy if exists "manager table delete" on public.tables;
create policy "manager table delete"
on public.tables
for delete to authenticated
using (public.is_manager());

-- Customers do not directly query any session/order/bill table. Only the
-- security-definer RPCs can expose the minimum data required by token.
drop policy if exists "staff read dining sessions" on public.dining_sessions;
create policy "staff read dining sessions"
on public.dining_sessions
for select to authenticated
using (public.is_staff());

drop policy if exists "staff update dining sessions" on public.dining_sessions;
create policy "staff update dining sessions"
on public.dining_sessions
for update to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff read orders" on public.orders;
create policy "staff read orders"
on public.orders
for select to authenticated
using (public.is_staff());

drop policy if exists "staff insert orders" on public.orders;
create policy "staff insert orders"
on public.orders
for insert to authenticated
with check (public.is_staff());

drop policy if exists "staff update orders" on public.orders;
create policy "staff update orders"
on public.orders
for update to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff read order items" on public.order_items;
create policy "staff read order items"
on public.order_items
for select to authenticated
using (public.is_staff());

drop policy if exists "staff insert order items" on public.order_items;
create policy "staff insert order items"
on public.order_items
for insert to authenticated
with check (public.is_staff());

drop policy if exists "staff update order items" on public.order_items;
create policy "staff update order items"
on public.order_items
for update to authenticated
using (public.is_staff())
with check (public.is_staff());

drop policy if exists "staff read app settings" on public.app_settings;
create policy "staff read app settings"
on public.app_settings
for select to authenticated
using (public.is_staff());

drop policy if exists "manager update app settings" on public.app_settings;
create policy "manager update app settings"
on public.app_settings
for update to authenticated
using (public.is_manager())
with check (public.is_manager());

-- --------------------------------------------------------------------------
-- Realtime
-- --------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'orders'
  ) then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dining_sessions'
  ) then
    execute 'alter publication supabase_realtime add table public.dining_sessions';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select on public.products, public.tables to anon, authenticated;

grant select on public.profiles, public.dining_sessions,
  public.orders, public.order_items, public.app_settings
  to authenticated;

grant insert, update, delete on public.products to authenticated;
grant insert, update, delete on public.tables to authenticated;
grant insert, update on public.orders to authenticated;
grant insert, update on public.order_items to authenticated;
grant update on public.app_settings to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- --------------------------------------------------------------------------
-- Admin bootstrap
-- --------------------------------------------------------------------------
-- Create the first Auth user in Supabase Authentication > Users.
-- Then run, replacing UUID and PIN:
--
-- update public.profiles
-- set
--   role = 'admin',
--   pin_hash = extensions.crypt(
--     'YOUR_REAL_6_DIGIT_PIN',
--     extensions.gen_salt('bf')
--   )
-- where id = 'YOUR-AUTH-USER-UUID';
--
-- No production password is embedded in this source.
-- ============================================================================


-- ============================================================================
-- FOUR FLAVOURS — DISH IMAGE STORAGE
-- ============================================================================
--
-- Bucket:
--   dish-images
--
-- Rules:
--   • Public read/serving because dish photos are public restaurant content.
--   • Only manager/admin users can upload, update or delete.
--   • Only /products/* paths are allowed.
--   • Only WebP files are accepted.
--   • Final object size is capped at 2 MiB.
--
-- The frontend compresses/crops images before uploading.
-- ============================================================================

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'dish-images',
  'dish-images',
  true,
  2097152,
  array['image/webp']::text[]
)
on conflict (id)
do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/webp']::text[];


-- --------------------------------------------------------------------------
-- Storage security policies
-- --------------------------------------------------------------------------

drop policy if exists "four flavours managers upload dish images"
on storage.objects;

create policy "four flavours managers upload dish images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'dish-images'
  and public.is_manager()
  and name like 'products/%'
  and lower(right(name, 5)) = '.webp'
);


drop policy if exists "four flavours managers update dish images"
on storage.objects;

create policy "four flavours managers update dish images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'dish-images'
  and public.is_manager()
  and name like 'products/%'
  and lower(right(name, 5)) = '.webp'
)
with check (
  bucket_id = 'dish-images'
  and public.is_manager()
  and name like 'products/%'
  and lower(right(name, 5)) = '.webp'
);


drop policy if exists "four flavours managers delete dish images"
on storage.objects;

create policy "four flavours managers delete dish images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'dish-images'
  and public.is_manager()
  and name like 'products/%'
  and lower(right(name, 5)) = '.webp'
);
