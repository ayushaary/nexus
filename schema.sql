-- ============================================================================
-- NEXUS — Production schema for Supabase (Postgres + RLS)
-- ============================================================================
-- Run this once in the Supabase SQL Editor on a fresh project.
-- Safe to re-run: every object is created with IF NOT EXISTS / OR REPLACE
-- where Postgres supports it, and policies are dropped before recreation.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- EXTENSIONS
-- ----------------------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- PROFILES
-- One row per authenticated user. Created automatically on signup via trigger
-- below — never inserted manually from the client.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  bio text default '',
  avatar_url text,
  avatar_color_from text default '#7c5cfc',
  avatar_color_to text default '#fc5cce',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_.]{3,30}$')
);

create index if not exists idx_profiles_username on public.profiles (username);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);
  -- Display names/avatars are visible to any logged-in user (needed for
  -- group member lists, search, message authorship). No private fields
  -- live on this table; email lives in auth.users which is never exposed.

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- Auto-create a profile row whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base_username text;
  final_username text;
  suffix int := 0;
begin
  base_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)),
    '[^a-z0-9_.]', '', 'g'
  ));
  if length(base_username) < 3 then
    base_username := base_username || substr(md5(new.id::text), 1, 4);
  end if;
  final_username := base_username;
  while exists (select 1 from public.profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := base_username || suffix::text;
  end loop;

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    final_username,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- GROUPS (communities) + MEMBERSHIP
-- ----------------------------------------------------------------------------
create table if not exists public.groups (
  id uuid primary key default uuid_generate_v4(),
  name text not null check (char_length(name) between 1 and 80),
  description text default '',
  emoji text default '🏠',
  invite_code text unique not null default substr(replace(uuid_generate_v4()::text,'-',''), 1, 8),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists idx_group_members_user on public.group_members(user_id);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;

-- Helper: is the current user a member of a given group?
create or replace function public.is_group_member(gid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.group_members where group_id = gid and user_id = auth.uid());
$$;

drop policy if exists "groups_select_member" on public.groups;
create policy "groups_select_member" on public.groups
  for select to authenticated using (public.is_group_member(id));

drop policy if exists "groups_insert_any_authenticated" on public.groups;
create policy "groups_insert_any_authenticated" on public.groups
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "groups_update_owner_admin" on public.groups;
create policy "groups_update_owner_admin" on public.groups
  for update to authenticated using (
    exists(select 1 from public.group_members gm where gm.group_id = id and gm.user_id = auth.uid() and gm.role in ('owner','admin'))
  );

drop policy if exists "group_members_select_fellow_member" on public.group_members;
create policy "group_members_select_fellow_member" on public.group_members
  for select to authenticated using (public.is_group_member(group_id));

drop policy if exists "group_members_insert_self_or_admin" on public.group_members;
create policy "group_members_insert_self_or_admin" on public.group_members
  for insert to authenticated with check (
    user_id = auth.uid() -- joining yourself via invite code
    or exists(select 1 from public.group_members gm where gm.group_id = group_members.group_id and gm.user_id = auth.uid() and gm.role in ('owner','admin'))
  );

drop policy if exists "group_members_delete_self_or_admin" on public.group_members;
create policy "group_members_delete_self_or_admin" on public.group_members
  for delete to authenticated using (
    user_id = auth.uid()
    or exists(select 1 from public.group_members gm where gm.group_id = group_members.group_id and gm.user_id = auth.uid() and gm.role in ('owner','admin'))
  );

-- When a group is created, automatically add the creator as owner and
-- create a default #general channel.
create or replace function public.handle_new_group()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.group_members(group_id, user_id, role) values (new.id, new.created_by, 'owner');
  insert into public.channels(group_id, name, emoji, created_by) values (new.id, 'general', '💬', new.created_by);
  return new;
end;
$$;

drop trigger if exists on_group_created on public.groups;
create trigger on_group_created
  after insert on public.groups
  for each row execute function public.handle_new_group();

-- ----------------------------------------------------------------------------
-- CHANNELS
-- ----------------------------------------------------------------------------
create table if not exists public.channels (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  emoji text default '💬',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.channels enable row level security;

drop policy if exists "channels_select_member" on public.channels;
create policy "channels_select_member" on public.channels
  for select to authenticated using (public.is_group_member(group_id));

drop policy if exists "channels_insert_member" on public.channels;
create policy "channels_insert_member" on public.channels
  for insert to authenticated with check (public.is_group_member(group_id) and created_by = auth.uid());

-- ----------------------------------------------------------------------------
-- DIRECT MESSAGE THREADS (1:1, separate from group channels)
-- ----------------------------------------------------------------------------
create table if not exists public.dm_threads (
  id uuid primary key default uuid_generate_v4(),
  user_a uuid not null references public.profiles(id),
  user_b uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint dm_distinct_users check (user_a <> user_b),
  constraint dm_unique_pair unique (user_a, user_b)
);

alter table public.dm_threads enable row level security;

drop policy if exists "dm_threads_select_participant" on public.dm_threads;
create policy "dm_threads_select_participant" on public.dm_threads
  for select to authenticated using (auth.uid() in (user_a, user_b));

drop policy if exists "dm_threads_insert_participant" on public.dm_threads;
create policy "dm_threads_insert_participant" on public.dm_threads
  for insert to authenticated with check (auth.uid() in (user_a, user_b));

-- Always store the pair with user_a < user_b so (A,B) and (B,A) collide
-- into the same unique row instead of creating duplicate threads.
create or replace function public.normalize_dm_pair()
returns trigger language plpgsql as $$
declare tmp uuid;
begin
  if new.user_a > new.user_b then
    tmp := new.user_a;
    new.user_a := new.user_b;
    new.user_b := tmp;
  end if;
  return new;
end;
$$;

drop trigger if exists before_dm_thread_insert on public.dm_threads;
create trigger before_dm_thread_insert
  before insert on public.dm_threads
  for each row execute function public.normalize_dm_pair();

-- ----------------------------------------------------------------------------
-- MESSAGES (shared table for channel messages and DMs; exactly one of
-- channel_id / dm_thread_id is set)
-- ----------------------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default uuid_generate_v4(),
  channel_id uuid references public.channels(id) on delete cascade,
  dm_thread_id uuid references public.dm_threads(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  body text,
  reply_to_id uuid references public.messages(id) on delete set null,
  file_url text,
  file_name text,
  file_size_bytes bigint,
  file_type text,
  voice_note_url text,
  voice_note_duration_seconds numeric,
  is_ai boolean not null default false,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  constraint one_destination check (
    (channel_id is not null and dm_thread_id is null) or
    (channel_id is null and dm_thread_id is not null)
  ),
  constraint has_content check (
    body is not null or file_url is not null or voice_note_url is not null
  )
);

create index if not exists idx_messages_channel on public.messages(channel_id, created_at);
create index if not exists idx_messages_dm on public.messages(dm_thread_id, created_at);

alter table public.messages enable row level security;

drop policy if exists "messages_select_in_scope" on public.messages;
create policy "messages_select_in_scope" on public.messages
  for select to authenticated using (
    (channel_id is not null and public.is_group_member((select group_id from public.channels c where c.id = channel_id)))
    or
    (dm_thread_id is not null and exists(select 1 from public.dm_threads t where t.id = dm_thread_id and auth.uid() in (t.user_a, t.user_b)))
  );

drop policy if exists "messages_insert_in_scope" on public.messages;
create policy "messages_insert_in_scope" on public.messages
  for insert to authenticated with check (
    author_id = auth.uid() and (
      (channel_id is not null and public.is_group_member((select group_id from public.channels c where c.id = channel_id)))
      or
      (dm_thread_id is not null and exists(select 1 from public.dm_threads t where t.id = dm_thread_id and auth.uid() in (t.user_a, t.user_b)))
    )
  );

drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_own" on public.messages
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own" on public.messages
  for delete to authenticated using (author_id = auth.uid());

-- ----------------------------------------------------------------------------
-- REACTIONS
-- ----------------------------------------------------------------------------
create table if not exists public.reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

alter table public.reactions enable row level security;

drop policy if exists "reactions_select_in_scope" on public.reactions;
create policy "reactions_select_in_scope" on public.reactions
  for select to authenticated using (
    exists(
      select 1 from public.messages m where m.id = message_id and (
        (m.channel_id is not null and public.is_group_member((select group_id from public.channels c where c.id = m.channel_id)))
        or (m.dm_thread_id is not null and exists(select 1 from public.dm_threads t where t.id = m.dm_thread_id and auth.uid() in (t.user_a, t.user_b)))
      )
    )
  );

drop policy if exists "reactions_insert_own" on public.reactions;
create policy "reactions_insert_own" on public.reactions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "reactions_delete_own" on public.reactions;
create policy "reactions_delete_own" on public.reactions
  for delete to authenticated using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- POLLS
-- ----------------------------------------------------------------------------
create table if not exists public.polls (
  id uuid primary key default uuid_generate_v4(),
  message_id uuid not null references public.messages(id) on delete cascade,
  question text not null,
  closes_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.poll_options (
  id uuid primary key default uuid_generate_v4(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  option_text text not null,
  position int not null default 0
);

create table if not exists public.poll_votes (
  poll_option_id uuid not null references public.poll_options(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  poll_id uuid not null references public.polls(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id) -- one vote per user per poll; voting again moves it
);

alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;

drop policy if exists "polls_select_in_scope" on public.polls;
create policy "polls_select_in_scope" on public.polls
  for select to authenticated using (
    exists(select 1 from public.messages m where m.id = message_id and (
      (m.channel_id is not null and public.is_group_member((select group_id from public.channels c where c.id = m.channel_id)))
      or (m.dm_thread_id is not null and exists(select 1 from public.dm_threads t where t.id = m.dm_thread_id and auth.uid() in (t.user_a, t.user_b)))
    ))
  );
drop policy if exists "polls_insert_in_scope" on public.polls;
create policy "polls_insert_in_scope" on public.polls
  for insert to authenticated with check (
    exists(select 1 from public.messages m where m.id = message_id and m.author_id = auth.uid())
  );

drop policy if exists "poll_options_select_in_scope" on public.poll_options;
create policy "poll_options_select_in_scope" on public.poll_options
  for select to authenticated using (
    exists(select 1 from public.polls p where p.id = poll_id)
  );
drop policy if exists "poll_options_insert_in_scope" on public.poll_options;
create policy "poll_options_insert_in_scope" on public.poll_options
  for insert to authenticated with check (
    exists(select 1 from public.polls p join public.messages m on m.id = p.message_id where p.id = poll_id and m.author_id = auth.uid())
  );

drop policy if exists "poll_votes_select_in_scope" on public.poll_votes;
create policy "poll_votes_select_in_scope" on public.poll_votes
  for select to authenticated using (
    exists(
      select 1 from public.polls p join public.messages m on m.id = p.message_id
      where p.id = poll_votes.poll_id and (
        (m.channel_id is not null and public.is_group_member((select group_id from public.channels c where c.id = m.channel_id)))
        or (m.dm_thread_id is not null and exists(select 1 from public.dm_threads t where t.id = m.dm_thread_id and auth.uid() in (t.user_a, t.user_b)))
      )
    )
  );
drop policy if exists "poll_votes_upsert_own" on public.poll_votes;
create policy "poll_votes_upsert_own" on public.poll_votes
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "poll_votes_update_own" on public.poll_votes;
create policy "poll_votes_update_own" on public.poll_votes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "poll_votes_delete_own" on public.poll_votes;
create policy "poll_votes_delete_own" on public.poll_votes
  for delete to authenticated using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- EVENTS + RSVPS
-- ----------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text default '',
  emoji text default '📅',
  starts_at timestamptz not null,
  is_all_day boolean not null default false,
  is_recurring boolean not null default false,
  recurrence_rule text, -- e.g. 'daily', 'weekly' — interpreted client-side
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.event_rsvps (
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'going' check (status in ('going','maybe','not_going')),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;

drop policy if exists "events_select_member" on public.events;
create policy "events_select_member" on public.events
  for select to authenticated using (public.is_group_member(group_id));
drop policy if exists "events_insert_member" on public.events;
create policy "events_insert_member" on public.events
  for insert to authenticated with check (public.is_group_member(group_id) and created_by = auth.uid());
drop policy if exists "events_update_creator_or_admin" on public.events;
create policy "events_update_creator_or_admin" on public.events
  for update to authenticated using (
    created_by = auth.uid()
    or exists(select 1 from public.group_members gm where gm.group_id = events.group_id and gm.user_id = auth.uid() and gm.role in ('owner','admin'))
  );
drop policy if exists "events_delete_creator_or_admin" on public.events;
create policy "events_delete_creator_or_admin" on public.events
  for delete to authenticated using (
    created_by = auth.uid()
    or exists(select 1 from public.group_members gm where gm.group_id = events.group_id and gm.user_id = auth.uid() and gm.role in ('owner','admin'))
  );

drop policy if exists "rsvps_select_in_scope" on public.event_rsvps;
create policy "rsvps_select_in_scope" on public.event_rsvps
  for select to authenticated using (
    exists(select 1 from public.events e where e.id = event_id and public.is_group_member(e.group_id))
  );
drop policy if exists "rsvps_upsert_own" on public.event_rsvps;
create policy "rsvps_upsert_own" on public.event_rsvps
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "rsvps_update_own" on public.event_rsvps;
create policy "rsvps_update_own" on public.event_rsvps
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- GOALS + TASKS
-- ----------------------------------------------------------------------------
create table if not exists public.goals (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  emoji text default '🎯',
  tag text default 'general',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default uuid_generate_v4(),
  goal_id uuid not null references public.goals(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 200),
  done boolean not null default false,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.goals enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "goals_select_member" on public.goals;
create policy "goals_select_member" on public.goals
  for select to authenticated using (public.is_group_member(group_id));
drop policy if exists "goals_insert_member" on public.goals;
create policy "goals_insert_member" on public.goals
  for insert to authenticated with check (public.is_group_member(group_id) and created_by = auth.uid());
drop policy if exists "goals_delete_creator" on public.goals;
create policy "goals_delete_creator" on public.goals
  for delete to authenticated using (created_by = auth.uid());

drop policy if exists "tasks_select_in_scope" on public.tasks;
create policy "tasks_select_in_scope" on public.tasks
  for select to authenticated using (
    exists(select 1 from public.goals g where g.id = goal_id and public.is_group_member(g.group_id))
  );
drop policy if exists "tasks_insert_in_scope" on public.tasks;
create policy "tasks_insert_in_scope" on public.tasks
  for insert to authenticated with check (
    created_by = auth.uid() and exists(select 1 from public.goals g where g.id = goal_id and public.is_group_member(g.group_id))
  );
drop policy if exists "tasks_update_in_scope" on public.tasks;
create policy "tasks_update_in_scope" on public.tasks
  for update to authenticated using (
    exists(select 1 from public.goals g where g.id = goal_id and public.is_group_member(g.group_id))
  );
drop policy if exists "tasks_delete_in_scope" on public.tasks;
create policy "tasks_delete_in_scope" on public.tasks
  for delete to authenticated using (
    created_by = auth.uid() or exists(select 1 from public.goals g where g.id = goal_id and public.is_group_member(g.group_id))
  );

-- ----------------------------------------------------------------------------
-- STORIES (24h-expiring posts)
-- ----------------------------------------------------------------------------
create table if not exists public.stories (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  media_url text,
  caption text default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

alter table public.stories enable row level security;

drop policy if exists "stories_select_member_unexpired" on public.stories;
create policy "stories_select_member_unexpired" on public.stories
  for select to authenticated using (public.is_group_member(group_id) and expires_at > now());
drop policy if exists "stories_insert_member" on public.stories;
create policy "stories_insert_member" on public.stories
  for insert to authenticated with check (public.is_group_member(group_id) and author_id = auth.uid());
drop policy if exists "stories_delete_own" on public.stories;
create policy "stories_delete_own" on public.stories
  for delete to authenticated using (author_id = auth.uid());

-- ----------------------------------------------------------------------------
-- MEMORY VAULT (saved/pinned items organized into collections)
-- ----------------------------------------------------------------------------
create table if not exists public.vault_collections (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  emoji text default '🗂️',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.vault_items (
  id uuid primary key default uuid_generate_v4(),
  collection_id uuid references public.vault_collections(id) on delete set null,
  group_id uuid not null references public.groups(id) on delete cascade,
  media_url text,
  caption text default '',
  source_message_id uuid references public.messages(id) on delete set null,
  saved_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.vault_collections enable row level security;
alter table public.vault_items enable row level security;

drop policy if exists "vault_collections_select_member" on public.vault_collections;
create policy "vault_collections_select_member" on public.vault_collections
  for select to authenticated using (public.is_group_member(group_id));
drop policy if exists "vault_collections_insert_member" on public.vault_collections;
create policy "vault_collections_insert_member" on public.vault_collections
  for insert to authenticated with check (public.is_group_member(group_id) and created_by = auth.uid());

drop policy if exists "vault_items_select_member" on public.vault_items;
create policy "vault_items_select_member" on public.vault_items
  for select to authenticated using (public.is_group_member(group_id));
drop policy if exists "vault_items_insert_member" on public.vault_items;
create policy "vault_items_insert_member" on public.vault_items
  for insert to authenticated with check (public.is_group_member(group_id) and saved_by = auth.uid());
drop policy if exists "vault_items_delete_own" on public.vault_items;
create policy "vault_items_delete_own" on public.vault_items
  for delete to authenticated using (saved_by = auth.uid());

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  type text not null, -- 'reaction','poll','task','mention','invite','ai'
  title text not null,
  link_group_id uuid references public.groups(id),
  link_channel_id uuid references public.channels(id),
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user on public.notifications(user_id, created_at desc);

alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "notifications_insert_system" on public.notifications;
create policy "notifications_insert_system" on public.notifications
  for insert to authenticated with check (true); -- created by triggers/functions below

-- Notify the message author when someone reacts to it (skip self-reactions).
create or replace function public.notify_on_reaction()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  msg record;
  actor_name text;
begin
  select * into msg from public.messages where id = new.message_id;
  if msg.author_id = new.user_id then
    return new; -- don't notify yourself
  end if;
  select display_name into actor_name from public.profiles where id = new.user_id;
  insert into public.notifications(user_id, actor_id, type, title, link_channel_id)
  values (msg.author_id, new.user_id, 'reaction', actor_name || ' reacted ' || new.emoji || ' to your message', msg.channel_id);
  return new;
end;
$$;

drop trigger if exists on_reaction_notify on public.reactions;
create trigger on_reaction_notify
  after insert on public.reactions
  for each row execute function public.notify_on_reaction();

-- ----------------------------------------------------------------------------
-- updated_at maintenance
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- REALTIME — expose tables to Supabase Realtime so the client can subscribe
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reactions') then
    alter publication supabase_realtime add table public.reactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'poll_votes') then
    alter publication supabase_realtime add table public.poll_votes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- STORAGE BUCKETS (avatars, attachments, voice notes, story/vault media)
-- Run separately if these error — Supabase sometimes needs buckets created
-- via the dashboard UI on certain plans. SQL form included for completeness.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('voice-notes', 'voice-notes', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

drop policy if exists "avatar_upload_own" on storage.objects;
create policy "avatar_upload_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "avatar_update_own" on storage.objects;
create policy "avatar_update_own" on storage.objects
  for update to authenticated using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "avatar_public_read" on storage.objects;
create policy "avatar_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "attachments_upload_authenticated" on storage.objects;
create policy "attachments_upload_authenticated" on storage.objects
  for insert to authenticated with check (bucket_id = 'attachments');
drop policy if exists "attachments_public_read" on storage.objects;
create policy "attachments_public_read" on storage.objects
  for select using (bucket_id = 'attachments');

drop policy if exists "voicenotes_upload_authenticated" on storage.objects;
create policy "voicenotes_upload_authenticated" on storage.objects
  for insert to authenticated with check (bucket_id = 'voice-notes');
drop policy if exists "voicenotes_public_read" on storage.objects;
create policy "voicenotes_public_read" on storage.objects
  for select using (bucket_id = 'voice-notes');

drop policy if exists "media_upload_authenticated" on storage.objects;
create policy "media_upload_authenticated" on storage.objects
  for insert to authenticated with check (bucket_id = 'media');
drop policy if exists "media_public_read" on storage.objects;
create policy "media_public_read" on storage.objects
  for select using (bucket_id = 'media');

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
