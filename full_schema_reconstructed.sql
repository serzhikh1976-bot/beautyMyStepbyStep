-- ============================================================================
-- ТОЧНАЯ СХЕМА БД beautyMyStepbyStep — для staging/тестового Supabase-проекта
-- ============================================================================
-- Взята напрямую из боевой базы (выгрузка через Supabase Dashboard), не
-- реконструкция по коду. Выполни целиком в SQL Editor нового проекта.
--
-- Порядок таблиц важен — учитывает foreign key зависимости (bots первым,
-- т.к. на него ссылаются почти все остальные).
-- ============================================================================

create table public.bots (
  id bigserial not null,
  number uuid not null default gen_random_uuid (),
  token text not null,
  city_name text not null,
  is_active boolean not null default true,
  manager_telegram_id bigint null,
  community_topic_id bigint null,
  constraint bots_pkey primary key (id),
  constraint bots_number_key unique (number),
  constraint bots_token_key unique (token)
) TABLESPACE pg_default;

create table public.services (
  id serial not null,
  name text not null,
  is_active boolean not null default true,
  constraint services_pkey primary key (id)
) TABLESPACE pg_default;

create table public.users (
  telegram_id bigint not null,
  bot_id bigint not null,
  role text not null,
  constraint users_pkey primary key (telegram_id, bot_id),
  constraint users_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE,
  constraint users_role_check check (
    (role = any (array['client'::text, 'master'::text]))
  )
) TABLESPACE pg_default;

create table public.bot_services (
  bot_id bigint not null,
  service_id integer not null,
  is_enabled boolean not null default true,
  constraint bot_services_pkey primary key (bot_id, service_id),
  constraint bot_services_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE,
  constraint bot_services_service_id_fkey foreign KEY (service_id) references services (id) on delete CASCADE
) TABLESPACE pg_default;

create table public.districts (
  id serial not null,
  bot_id bigint not null,
  name text not null,
  constraint districts_pkey primary key (id),
  constraint districts_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists districts_bot_id_idx on public.districts using btree (bot_id) TABLESPACE pg_default;

create table public.sub_districts (
  id serial not null,
  district_id integer not null,
  name text not null,
  constraint sub_districts_pkey primary key (id),
  constraint sub_districts_district_id_fkey foreign KEY (district_id) references districts (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists sub_districts_district_id_idx on public.sub_districts using btree (district_id) TABLESPACE pg_default;

create table public.masters_profiles (
  master_id bigint not null,
  bot_id bigint not null,
  name text not null,
  price_from integer null,
  sub_district_id integer null,
  photos text[] not null default '{}'::text[],
  trial_expires_at timestamp with time zone null,
  is_active boolean not null default true,
  district_id integer null,
  last_profile_msg_id bigint null,
  constraint masters_profiles_pkey primary key (master_id, bot_id),
  constraint masters_profiles_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE,
  constraint masters_profiles_district_id_fkey foreign KEY (district_id) references districts (id) on delete set null,
  constraint masters_profiles_sub_district_id_fkey foreign KEY (sub_district_id) references sub_districts (id) on delete set null
) TABLESPACE pg_default;
create index IF not exists masters_profiles_bot_id_is_active_idx on public.masters_profiles using btree (bot_id, is_active) TABLESPACE pg_default;
create index IF not exists masters_profiles_sub_district_id_idx on public.masters_profiles using btree (sub_district_id) TABLESPACE pg_default;

create table public.master_services (
  master_id bigint not null,
  service_id integer not null,
  bot_id bigint not null,
  duration_minutes integer not null default 60,
  constraint master_services_pkey primary key (master_id, bot_id, service_id),
  constraint master_services_master_id_bot_id_fkey foreign KEY (master_id, bot_id) references masters_profiles (master_id, bot_id) on delete CASCADE,
  constraint master_services_service_id_fkey foreign KEY (service_id) references services (id) on delete CASCADE
) TABLESPACE pg_default;

create table public.master_price_items (
  id uuid not null default gen_random_uuid (),
  master_id bigint not null,
  bot_id integer not null,
  service_id integer not null,
  name text not null,
  price integer not null,
  created_at timestamp with time zone not null default now(),
  constraint master_price_items_pkey primary key (id)
) TABLESPACE pg_default;
create index IF not exists idx_master_price_items_lookup on public.master_price_items using btree (bot_id, master_id, service_id) TABLESPACE pg_default;

create table public.blocked_clients (
  id bigserial not null,
  bot_id bigint not null,
  master_id bigint not null,
  client_id bigint not null,
  created_at timestamp with time zone not null default now(),
  constraint blocked_clients_pkey primary key (id),
  constraint blocked_clients_unique unique (bot_id, master_id, client_id),
  constraint blocked_clients_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists blocked_clients_master_lookup_idx on public.blocked_clients using btree (bot_id, master_id, client_id) TABLESPACE pg_default;

create table public.active_chats (
  id uuid not null default gen_random_uuid (),
  bot_id bigint not null,
  client_id bigint not null,
  master_id bigint not null,
  updated_at timestamp with time zone not null default now(),
  status text not null default 'active'::text,
  last_master_button_msg_id bigint null,
  last_client_button_msg_id bigint null,
  warning_sent boolean not null default false,
  extended boolean not null default false,
  constraint active_chats_pkey primary key (id),
  constraint active_chats_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE,
  constraint active_chats_status_check check (
    (status = any (array['active'::text, 'finished'::text, 'timeout'::text]))
  )
) TABLESPACE pg_default;
create index IF not exists active_chats_bot_id_status_idx on public.active_chats using btree (bot_id, status) TABLESPACE pg_default;
create index IF not exists active_chats_client_id_idx on public.active_chats using btree (client_id) TABLESPACE pg_default;
create index IF not exists active_chats_master_id_idx on public.active_chats using btree (master_id) TABLESPACE pg_default;
create index IF not exists idx_active_chats_pending on public.active_chats using btree (updated_at) TABLESPACE pg_default
where (status = 'active'::text);

create table public.chat_message_log (
  id bigserial not null,
  chat_id uuid not null,
  sender_id bigint not null,
  text text null,
  photo_ids text[] null default '{}'::text[],
  created_at timestamp with time zone not null default now(),
  constraint chat_message_log_pkey primary key (id),
  constraint chat_message_log_chat_id_fkey foreign KEY (chat_id) references active_chats (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists chat_message_log_chat_id_created_at_idx on public.chat_message_log using btree (chat_id, created_at) TABLESPACE pg_default;
create index IF not exists chat_message_log_created_at_idx on public.chat_message_log using btree (created_at) TABLESPACE pg_default;

create table public.chat_messages (
  id bigserial not null,
  chat_id uuid not null,
  message_id bigint not null,
  constraint chat_messages_pkey primary key (id),
  constraint chat_messages_chat_id_fkey foreign KEY (chat_id) references active_chats (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists chat_messages_message_id_idx on public.chat_messages using btree (message_id) TABLESPACE pg_default;

create table public.orders (
  id uuid not null default gen_random_uuid (),
  bot_id bigint not null,
  client_id bigint not null,
  sub_district_id integer null,
  service text not null,
  description text not null default ''::text,
  status text not null default 'active'::text,
  created_at timestamp with time zone not null default now(),
  constraint orders_pkey primary key (id),
  constraint orders_bot_id_fkey foreign KEY (bot_id) references bots (id) on delete CASCADE,
  constraint orders_sub_district_id_fkey foreign KEY (sub_district_id) references sub_districts (id) on delete set null,
  constraint orders_status_check check (
    (status = any (array['active'::text, 'closed'::text, 'closed_expired'::text]))
  )
) TABLESPACE pg_default;
create index IF not exists orders_bot_id_status_idx on public.orders using btree (bot_id, status) TABLESPACE pg_default;
create index IF not exists orders_client_id_idx on public.orders using btree (client_id) TABLESPACE pg_default;

create table public.order_responses (
  id uuid not null default gen_random_uuid (),
  order_id uuid not null,
  master_id bigint not null,
  message_to_client text not null default ''::text,
  created_at timestamp with time zone not null default now(),
  constraint order_responses_pkey primary key (id),
  constraint order_responses_order_id_fkey foreign KEY (order_id) references orders (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists order_responses_order_id_idx on public.order_responses using btree (order_id) TABLESPACE pg_default;

create table public.broadcast_messages (
  id serial not null,
  order_id uuid not null,
  master_id bigint not null,
  message_id integer not null,
  constraint broadcast_messages_pkey primary key (id),
  constraint broadcast_messages_order_id_fkey foreign KEY (order_id) references orders (id) on delete CASCADE
) TABLESPACE pg_default;
create index IF not exists broadcast_messages_order_id_master_id_idx on public.broadcast_messages using btree (order_id, master_id) TABLESPACE pg_default;

-- Поддержка мастер → менеджер/суперадмин через admin-бот
create table public.support_messages (
  id                bigserial primary key,
  admin_message_id  bigint not null,
  bot_id            bigint not null references bots(id) on delete cascade,
  master_id         bigint not null,
  message_text      text not null default '',
  created_at        timestamptz not null default now()
);
create index IF not exists idx_support_messages_lookup on public.support_messages using btree (admin_message_id);

create table public.support_replies (
  id                  bigserial primary key,
  support_message_id  bigint not null references support_messages(id) on delete cascade,
  reply_text          text not null,
  admin_telegram_id   bigint not null,
  created_at          timestamptz not null default now()
);
create index IF not exists idx_support_replies_lookup on public.support_replies using btree (support_message_id);

-- Система записи клиентов к мастеру (календарь с самообслуживанием)
create table public.master_schedule_settings (
  master_id bigint not null,
  bot_id bigint not null,
  working_days smallint[] not null default '{1,2,3,4,5}',
  start_time time not null default '09:00',
  end_time time not null default '18:00',
  reminder_master_minutes_before integer not null default 60,
  reminder_client_minutes_before integer not null default 120,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint master_schedule_settings_pkey primary key (master_id, bot_id),
  constraint master_schedule_settings_master_bot_fkey foreign key (master_id, bot_id) references masters_profiles (master_id, bot_id) on delete cascade
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  bot_id bigint not null references bots(id) on delete cascade,
  master_id bigint not null,
  client_id bigint not null,
  service_id integer not null references services(id),
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','completed')),
  reminder_master_sent boolean not null default false,
  reminder_client_sent boolean not null default false,
  created_at timestamptz not null default now(),
  constraint appointments_master_bot_fkey foreign key (master_id, bot_id) references masters_profiles (master_id, bot_id) on delete cascade
);
create index IF not exists idx_appointments_master_slot on public.appointments using btree (master_id, bot_id, slot_start) where (status = 'confirmed'::text);
create index IF not exists idx_appointments_client on public.appointments using btree (client_id, bot_id) where (status = 'confirmed'::text);