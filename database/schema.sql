-- Apply once in the Supabase SQL editor for this portfolio.
create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.portfolio_site_owners (
  user_id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table private.portfolio_site_owners enable row level security;
alter table private.portfolio_site_owners force row level security;
revoke all on table private.portfolio_site_owners from public, anon, authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Student',
  username text not null unique check (char_length(username) between 3 and 32),
  avatar_path text,
  role text not null default 'student' check (role in ('student', 'admin')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
alter table public.profiles add column if not exists display_name text not null default 'Student';
update public.profiles p
set display_name = left(case
  when char_length(trim(coalesce(u.raw_user_meta_data ->> 'full_name', ''))) between 2 and 80
    then trim(u.raw_user_meta_data ->> 'full_name')
  else p.username
end, 80)
from auth.users u
where u.id = p.id and p.display_name = 'Student';
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_display_name_length'
  ) then
    alter table public.profiles add constraint profiles_display_name_length
      check (char_length(trim(display_name)) between 2 and 80);
  end if;
end $$;

create or replace function public.is_community_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.portfolio_site_owners
    where user_id = (select auth.uid())
  );
$$;
create or replace function public.is_portfolio_owner()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.portfolio_site_owners
    where user_id = (select auth.uid())
  );
$$;

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create or replace function public.is_conversation_member(target_conversation uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = target_conversation and user_id = (select auth.uid())
  );
$$;

create table if not exists public.direct_conversations (
  user_one uuid not null references auth.users(id) on delete cascade,
  user_two uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null unique references public.conversations(id) on delete cascade,
  constraint direct_conversations_pair_order check (user_one < user_two),
  primary key (user_one, user_two)
);

create table if not exists public.user_blocks (
  blocked_user uuid primary key references auth.users(id) on delete cascade,
  blocked_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_community_blocked(target_user uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.user_blocks where blocked_user = target_user);
$$;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null default '',
  attachment_path text,
  attachment_name text,
  created_at timestamptz not null default now(),
  constraint messages_content_length check (char_length(content) <= 5000),
  constraint messages_content_or_file check (char_length(trim(content)) > 0 or attachment_path is not null)
);
create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at);

create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table if not exists public.conversation_presence (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  typing_until timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (char_length(reason) between 3 and 500),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (message_id, reporter_id)
);

create table if not exists public.contact_rate_limits (
  request_hash text primary key check (request_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0)
);
create index if not exists contact_rate_limits_window_idx on public.contact_rate_limits (window_started_at);
alter table public.contact_rate_limits enable row level security;
revoke all on public.contact_rate_limits from anon, authenticated;

create or replace function public.allow_contact_submission(request_hash text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_request_count integer;
begin
  if request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid rate-limit key';
  end if;

  delete from public.contact_rate_limits
  where window_started_at < v_now - interval '1 day';

  insert into public.contact_rate_limits as limits (request_hash, window_started_at, request_count)
  values ($1, v_now, 1)
  on conflict (request_hash) do update set
    window_started_at = case
      when limits.window_started_at < v_now - interval '15 minutes'
        then v_now
      else limits.window_started_at
    end,
    request_count = case
      when limits.window_started_at < v_now - interval '15 minutes'
        then 1
      else limits.request_count + 1
    end
  returning limits.request_count into v_request_count;

  return v_request_count <= 5;
end;
$$;
revoke execute on function public.allow_contact_submission(text) from public, anon, authenticated;
grant execute on function public.allow_contact_submission(text) to service_role;

create or replace function public.create_community_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  requested_username text;
  safe_username text;
begin
  requested_username := coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'student_' || left(replace(new.id::text, '-', ''), 12));
  safe_username := left(regexp_replace(requested_username, '[^A-Za-z0-9_]', '', 'g'), 32);
  if char_length(safe_username) < 3 then
    safe_username := 'student_' || left(replace(new.id::text, '-', ''), 12);
  end if;
  if exists (select 1 from public.profiles where username = safe_username) then
    safe_username := left(safe_username, 19) || '_' || left(replace(new.id::text, '-', ''), 12);
  end if;

  insert into public.profiles (id, display_name, username, role)
  values (
    new.id,
    left(case
      when char_length(trim(coalesce(new.raw_user_meta_data ->> 'full_name', ''))) between 2 and 80
        then trim(new.raw_user_meta_data ->> 'full_name')
      else requested_username
    end, 80),
    safe_username,
    'student'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_community_user_created on auth.users;
create trigger on_community_user_created
  after insert on auth.users
  for each row execute function public.create_community_profile();

update public.profiles p
set role = case when exists (
  select 1 from private.portfolio_site_owners o where o.user_id = p.id
) then 'admin' else 'student' end
where p.role is distinct from case when exists (
  select 1 from private.portfolio_site_owners o where o.user_id = p.id
) then 'admin' else 'student' end;

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 2800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists community_posts_created_idx on public.community_posts (created_at desc);

create table if not exists public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 800),
  created_at timestamptz not null default now()
);
create index if not exists community_comments_post_created_idx on public.community_comments (post_id, created_at);

create table if not exists public.community_post_likes (
  post_id uuid not null references public.community_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create or replace function public.start_direct_conversation(other_user uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  first_user uuid;
  second_user uuid;
  found_conversation uuid;
begin
  if current_user_id is null or other_user is null or other_user = current_user_id then
    raise exception 'A valid other user is required';
  end if;
  if not exists (select 1 from public.profiles where id = other_user) then
    raise exception 'User not found';
  end if;
  if exists (select 1 from public.user_blocks where blocked_user in (current_user_id, other_user)) then
    raise exception 'Messaging is unavailable for one of these accounts';
  end if;

  first_user := least(current_user_id, other_user);
  second_user := greatest(current_user_id, other_user);
  select conversation_id into found_conversation
    from public.direct_conversations where user_one = first_user and user_two = second_user;
  if found_conversation is not null then
    return found_conversation;
  end if;

  insert into public.conversations (created_by) values (current_user_id)
    returning id into found_conversation;
  insert into public.conversation_members (conversation_id, user_id)
    values (found_conversation, first_user), (found_conversation, second_user);
  insert into public.direct_conversations (user_one, user_two, conversation_id)
    values (first_user, second_user, found_conversation);
  return found_conversation;
exception
  when unique_violation then
    select conversation_id into found_conversation
      from public.direct_conversations where user_one = first_user and user_two = second_user;
    return found_conversation;
end;
$$;

create or replace function public.admin_block_community_user(target_user uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_community_admin() then
    raise exception 'Administrator access required';
  end if;
  if target_user = auth.uid() then
    raise exception 'Cannot block the current account';
  end if;
  insert into public.user_blocks (blocked_user, blocked_by)
  values (target_user, auth.uid())
  on conflict (blocked_user) do update set blocked_by = excluded.blocked_by, created_at = now();
end;
$$;

create or replace function public.admin_unblock_community_user(target_user uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_community_admin() then
    raise exception 'Administrator access required';
  end if;
  delete from public.user_blocks where blocked_user = target_user;
end;
$$;

create or replace function public.enforce_message_rate_limit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  recent_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.sender_id::text, 0));
  select count(*) into recent_count from public.messages
    where sender_id = new.sender_id and created_at > now() - interval '1 minute';
  if recent_count >= 20 then
    raise exception 'Message rate limit reached. Try again shortly.';
  end if;
  return new;
end;
$$;
drop trigger if exists message_rate_limit on public.messages;
create trigger message_rate_limit before insert on public.messages
  for each row execute function public.enforce_message_rate_limit();

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.direct_conversations enable row level security;
alter table public.user_blocks enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.conversation_presence enable row level security;
alter table public.message_reports enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_post_likes enable row level security;

drop policy if exists "authenticated users read community posts" on public.community_posts;
create policy "authenticated users read community posts" on public.community_posts
  for select to authenticated using (true);
drop policy if exists "users create own community posts" on public.community_posts;
create policy "users create own community posts" on public.community_posts
  for insert to authenticated with check (author_id = (select auth.uid()));
drop policy if exists "authors update own community posts" on public.community_posts;
create policy "authors update own community posts" on public.community_posts
  for update to authenticated using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
drop policy if exists "authors delete own community posts" on public.community_posts;
create policy "authors delete own community posts" on public.community_posts
  for delete to authenticated using (author_id = (select auth.uid()));

drop policy if exists "authenticated users read community comments" on public.community_comments;
create policy "authenticated users read community comments" on public.community_comments
  for select to authenticated using (true);
drop policy if exists "users create own community comments" on public.community_comments;
create policy "users create own community comments" on public.community_comments
  for insert to authenticated with check (
    author_id = (select auth.uid()) and exists (
      select 1 from public.community_posts p where p.id = post_id
    )
  );
drop policy if exists "authors update own community comments" on public.community_comments;
create policy "authors update own community comments" on public.community_comments
  for update to authenticated using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
drop policy if exists "authors delete own community comments" on public.community_comments;
create policy "authors delete own community comments" on public.community_comments
  for delete to authenticated using (author_id = (select auth.uid()));

drop policy if exists "authenticated users read community likes" on public.community_post_likes;
create policy "authenticated users read community likes" on public.community_post_likes
  for select to authenticated using (true);
drop policy if exists "users like posts as themselves" on public.community_post_likes;
create policy "users like posts as themselves" on public.community_post_likes
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "users unlike posts as themselves" on public.community_post_likes;
create policy "users unlike posts as themselves" on public.community_post_likes
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "profiles visible to authenticated users" on public.profiles;
create policy "profiles visible to authenticated users" on public.profiles
  for select to authenticated using (true);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
revoke update on public.profiles from authenticated;
grant update (display_name, username, avatar_path, last_seen_at) on public.profiles to authenticated;

drop policy if exists "participants or owner read conversations" on public.conversations;
create policy "participants or owner read conversations" on public.conversations
  for select to authenticated using (
    public.is_community_admin() or public.is_conversation_member(id)
  );
drop policy if exists "participants or owner read members" on public.conversation_members;
create policy "participants or owner read members" on public.conversation_members
  for select to authenticated using (
    public.is_community_admin() or public.is_conversation_member(conversation_id)
  );
drop policy if exists "participants or owner read messages" on public.messages;
create policy "participants or owner read messages" on public.messages
  for select to authenticated using (
    public.is_community_admin() or public.is_conversation_member(conversation_id)
  );
drop policy if exists "participants send own messages" on public.messages;
create policy "participants send own messages" on public.messages
  for insert to authenticated with check (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
    and not public.is_community_blocked((select auth.uid()))
    and not public.is_community_blocked((
      select cm.user_id from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id <> (select auth.uid()) limit 1
    ))
  );
drop policy if exists "participants or owner read receipts" on public.message_reads;
create policy "participants or owner read receipts" on public.message_reads
  for select to authenticated using (
    public.is_community_admin() or exists (
      select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)
    )
  );
drop policy if exists "users mark own messages read" on public.message_reads;
create policy "users mark own messages read" on public.message_reads
  for insert to authenticated with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)
    )
  );
drop policy if exists "participants view typing state" on public.conversation_presence;
create policy "participants view typing state" on public.conversation_presence
  for select to authenticated using (
    public.is_community_admin() or public.is_conversation_member(conversation_id)
  );
drop policy if exists "users set own typing state" on public.conversation_presence;
create policy "users set own typing state" on public.conversation_presence
  for insert to authenticated with check (
    user_id = (select auth.uid()) and public.is_conversation_member(conversation_id)
  );
drop policy if exists "users update own typing state" on public.conversation_presence;
create policy "users update own typing state" on public.conversation_presence
  for update to authenticated using (
    user_id = (select auth.uid()) and public.is_conversation_member(conversation_id)
  ) with check (user_id = (select auth.uid()) and public.is_conversation_member(conversation_id));
drop policy if exists "reporters and owner read reports" on public.message_reports;
create policy "reporters and owner read reports" on public.message_reports
  for select to authenticated using (public.is_community_admin() or reporter_id = (select auth.uid()));
drop policy if exists "participants report messages" on public.message_reports;
create policy "participants report messages" on public.message_reports
  for insert to authenticated with check (
    reporter_id = (select auth.uid()) and exists (
      select 1 from public.messages m where m.id = message_id and public.is_conversation_member(m.conversation_id)
    )
  );
drop policy if exists "owner updates reports" on public.message_reports;
create policy "owner updates reports" on public.message_reports
  for update to authenticated using (public.is_community_admin())
  with check (public.is_community_admin());
drop policy if exists "owner views block list" on public.user_blocks;
create policy "owner views block list" on public.user_blocks
  for select to authenticated using (public.is_community_admin());

grant usage on schema public to authenticated;
revoke all on public.community_posts, public.community_comments, public.community_post_likes from anon, authenticated;
grant select on public.community_posts, public.community_comments, public.community_post_likes to authenticated;
grant insert (author_id, content) on public.community_posts to authenticated;
grant insert (post_id, author_id, content) on public.community_comments to authenticated;
grant insert (post_id, user_id) on public.community_post_likes to authenticated;
grant update (content) on public.community_posts, public.community_comments to authenticated;
grant delete on public.community_posts, public.community_comments, public.community_post_likes to authenticated;
grant select on public.profiles, public.conversations, public.conversation_members,
  public.messages, public.message_reads, public.conversation_presence, public.message_reports,
  public.user_blocks to authenticated;
grant insert on public.messages, public.message_reads, public.conversation_presence,
  public.message_reports to authenticated;
grant update (typing_until) on public.conversation_presence to authenticated;
grant update (status) on public.message_reports to authenticated;
grant execute on function public.start_direct_conversation(uuid) to authenticated;
grant execute on function public.is_portfolio_owner() to authenticated;
grant execute on function public.admin_block_community_user(uuid) to authenticated;
grant execute on function public.admin_unblock_community_user(uuid) to authenticated;
grant execute on function public.is_community_admin() to authenticated;
grant execute on function public.is_conversation_member(uuid) to authenticated;
grant execute on function public.is_community_blocked(uuid) to authenticated;
revoke execute on function public.start_direct_conversation(uuid) from public, anon;
revoke execute on function public.is_portfolio_owner() from public, anon;
revoke execute on function public.admin_block_community_user(uuid) from public, anon;
revoke execute on function public.admin_unblock_community_user(uuid) from public, anon;
revoke execute on function public.is_community_admin() from public, anon;
revoke execute on function public.is_conversation_member(uuid) from public, anon;
revoke execute on function public.is_community_blocked(uuid) from public, anon;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('community-files', 'community-files', false, 10485760, array['image/jpeg','image/png','image/webp','application/pdf','text/plain']),
  ('community-avatars', 'community-avatars', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "participants read community files" on storage.objects;
create policy "participants read community files" on storage.objects
  for select to authenticated using (
    bucket_id = 'community-files' and (
      public.is_community_admin() or exists (
        select 1 from public.conversation_members cm
        where cm.conversation_id::text = (storage.foldername(name))[1]
          and cm.user_id = (select auth.uid())
      )
    )
  );
drop policy if exists "participants upload community files" on storage.objects;
create policy "participants upload community files" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'community-files' and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id::text = (storage.foldername(name))[1]
        and cm.user_id = (select auth.uid())
    )
  );
drop policy if exists "users read community avatars" on storage.objects;
create policy "users read community avatars" on storage.objects
  for select to authenticated using (bucket_id = 'community-avatars');
drop policy if exists "users upload own avatar" on storage.objects;
create policy "users upload own avatar" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'community-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
  );
drop policy if exists "users update own avatar" on storage.objects;
create policy "users update own avatar" on storage.objects
  for update to authenticated using (
    bucket_id = 'community-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
  ) with check (
    bucket_id = 'community-avatars' and (storage.foldername(name))[1] = (select auth.uid())::text
  );

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_presence') then
    alter publication supabase_realtime add table public.conversation_presence;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'message_reads') then
    alter publication supabase_realtime add table public.message_reads;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_posts') then
    alter publication supabase_realtime add table public.community_posts;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_comments') then
    alter publication supabase_realtime add table public.community_comments;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_post_likes') then
    alter publication supabase_realtime add table public.community_post_likes;
  end if;
end $$;
