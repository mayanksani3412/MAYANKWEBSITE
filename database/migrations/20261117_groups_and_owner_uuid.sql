-- REVIEW ONLY: inspect this migration before applying it in the Supabase SQL editor.
-- It replaces email-based community admin authorization with the supplied Auth UUID
-- and adds group tables, RPCs, and RLS. It has not been applied to the live project.
begin;

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

do $$
begin
  if to_regclass('public.profiles') is null
    or to_regclass('public.community_posts') is null
    or to_regclass('public.community_comments') is null
    or to_regclass('public.community_post_likes') is null then
    raise exception 'Apply database/schema.sql before this migration.';
  end if;
  if not exists (
    select 1 from auth.users
    where id = 'b99248e8-5696-4eb2-9709-ca99ad87fd0b'::uuid
  ) then
    raise exception 'The configured owner UUID was not found in auth.users; verify it before applying this migration.';
  end if;
end
$$;

create table if not exists private.portfolio_site_owners (
  user_id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table private.portfolio_site_owners enable row level security;
alter table private.portfolio_site_owners force row level security;
revoke all on table private.portfolio_site_owners from public, anon, authenticated;

insert into private.portfolio_site_owners (user_id)
values ('b99248e8-5696-4eb2-9709-ca99ad87fd0b'::uuid)
on conflict (user_id) do nothing;
delete from private.portfolio_site_owners
where user_id <> 'b99248e8-5696-4eb2-9709-ca99ad87fd0b'::uuid;
insert into public.profiles (id, display_name, username, role)
select
  u.id,
  left(coalesce(nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''), 'Portfolio owner'), 80),
  'owner_' || left(replace(u.id::text, '-', ''), 26),
  'admin'
from auth.users u
where u.id = 'b99248e8-5696-4eb2-9709-ca99ad87fd0b'::uuid
on conflict (id) do update set role = 'admin';

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

create or replace function public.is_community_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select public.is_portfolio_owner();
$$;

create or replace function public.create_community_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  requested_username text;
  safe_username text;
begin
  requested_username := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'student_' || left(replace(new.id::text, '-', ''), 12)
  );
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

update public.profiles set role = 'student' where role <> 'student';
update public.profiles
set role = 'admin'
where id = 'b99248e8-5696-4eb2-9709-ca99ad87fd0b'::uuid;
revoke update on public.profiles from anon, authenticated;
grant update (display_name, username, avatar_path, last_seen_at) on public.profiles to authenticated;

revoke execute on function public.is_portfolio_owner() from public, anon;
grant execute on function public.is_portfolio_owner() to authenticated;
revoke execute on function public.is_community_admin() from public, anon;
grant execute on function public.is_community_admin() to authenticated;
revoke execute on function public.create_community_profile() from public, anon, authenticated;

create table if not exists public.community_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  description text not null default '' check (char_length(description) <= 1600),
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint community_group_avatar_owner_path check (
    avatar_path is null or split_part(avatar_path, '/', 1) = owner_id::text
  )
);
create index if not exists community_groups_visibility_created_idx
  on public.community_groups (visibility, created_at desc);
create index if not exists community_groups_owner_created_idx
  on public.community_groups (owner_id, created_at desc);
create index if not exists community_groups_name_prefix_idx
  on public.community_groups (lower(name) text_pattern_ops);

create table if not exists public.community_group_members (
  group_id uuid not null references public.community_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists community_group_members_user_idx
  on public.community_group_members (user_id, group_id);

create table if not exists public.community_group_join_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.community_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);
create index if not exists community_group_requests_owner_idx
  on public.community_group_join_requests (group_id, status, created_at);
create index if not exists community_group_requests_user_idx
  on public.community_group_join_requests (user_id, group_id);

create table if not exists public.community_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.community_groups(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists community_group_messages_group_created_idx
  on public.community_group_messages (group_id, created_at);
create index if not exists community_group_messages_sender_created_idx
  on public.community_group_messages (sender_id, created_at desc);

create or replace function public.is_community_group_member(target_group uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.community_group_members
    where group_id = target_group and user_id = (select auth.uid())
  );
$$;

create or replace function public.add_community_group_owner_as_member()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.community_group_members (group_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists community_group_owner_membership on public.community_groups;
create trigger community_group_owner_membership
  after insert on public.community_groups
  for each row execute function public.add_community_group_owner_as_member();

create or replace function public.reset_community_group_request_on_leave()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.community_group_join_requests
  set status = 'rejected'
  where group_id = old.group_id and user_id = old.user_id and status = 'approved';
  return old;
end;
$$;
drop trigger if exists community_group_request_reset_on_leave on public.community_group_members;
create trigger community_group_request_reset_on_leave
  after delete on public.community_group_members
  for each row execute function public.reset_community_group_request_on_leave();

create or replace function public.community_group_member_counts(target_group_ids uuid[])
returns table (group_id uuid, member_count bigint)
language sql stable security definer
set search_path = ''
as $$
  select members.group_id, count(*)::bigint
  from public.community_group_members members
  where members.group_id = any(coalesce(target_group_ids, '{}'::uuid[]))
    and (select auth.uid()) is not null
  group by members.group_id;
$$;

create or replace function public.request_community_group_join(target_group uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  group_visibility text;
  request_status text;
begin
  if current_user_id is null then
    raise exception 'Sign in to request group access.';
  end if;
  select visibility into group_visibility
  from public.community_groups where id = target_group;
  if not found or group_visibility <> 'private' then
    raise exception 'Private group not found.';
  end if;
  if exists (
    select 1 from public.community_group_members
    where group_id = target_group and user_id = current_user_id
  ) then
    return;
  end if;

  insert into public.community_group_join_requests as existing (group_id, user_id)
  values (target_group, current_user_id)
  on conflict (group_id, user_id) do update set
    status = 'pending',
    created_at = now()
  where existing.status = 'rejected'
  returning status into request_status;

  if not found then
    select status into request_status
    from public.community_group_join_requests
    where group_id = target_group and user_id = current_user_id;
  end if;
  if request_status <> 'pending' then
    raise exception 'This group request has already been approved.';
  end if;
end;
$$;

create or replace function public.decide_community_group_join_request(
  target_request uuid,
  approve_request boolean
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  request_group uuid;
  request_user uuid;
  request_state text;
begin
  if current_user_id is null then
    raise exception 'Sign in to manage group requests.';
  end if;
  select group_id, user_id, status
    into request_group, request_user, request_state
  from public.community_group_join_requests
  where id = target_request
  for update;
  if not found then
    raise exception 'Group request not found.';
  end if;
  if not public.is_portfolio_owner() and not exists (
    select 1 from public.community_groups
    where id = request_group and owner_id = current_user_id
  ) then
    raise exception 'Only this group owner or the portfolio owner can decide this request.';
  end if;
  if request_state <> 'pending' then
    raise exception 'This request has already been handled.';
  end if;

  if approve_request then
    insert into public.community_group_members (group_id, user_id, role)
    values (request_group, request_user, 'member')
    on conflict (group_id, user_id) do nothing;
    update public.community_group_join_requests
      set status = 'approved' where id = target_request;
  else
    update public.community_group_join_requests
      set status = 'rejected' where id = target_request;
  end if;
end;
$$;

create or replace function public.remove_community_group_member(
  target_group uuid,
  target_user uuid
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  group_owner uuid;
begin
  if current_user_id is null then
    raise exception 'Sign in to manage group membership.';
  end if;
  select owner_id into group_owner
  from public.community_groups where id = target_group;
  if not found then
    raise exception 'Group not found.';
  end if;
  if not public.is_portfolio_owner() and group_owner <> current_user_id then
    raise exception 'Only this group owner or the portfolio owner can remove members.';
  end if;
  if target_user = group_owner then
    raise exception 'The group owner cannot be removed.';
  end if;
  delete from public.community_group_members
  where group_id = target_group and user_id = target_user;
  if not found then
    raise exception 'Group member not found.';
  end if;
end;
$$;

create or replace function public.touch_community_group_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists community_group_updated_at on public.community_groups;
create trigger community_group_updated_at
  before update on public.community_groups
  for each row execute function public.touch_community_group_updated_at();

alter table public.community_groups enable row level security;
alter table public.community_group_members enable row level security;
alter table public.community_group_join_requests enable row level security;
alter table public.community_group_messages enable row level security;

drop policy if exists "authenticated users read group directory" on public.community_groups;
create policy "authenticated users read group directory" on public.community_groups
  for select to authenticated using (true);
drop policy if exists "users create groups as owner" on public.community_groups;
create policy "users create groups as owner" on public.community_groups
  for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists "group owners and site owner update group details" on public.community_groups;
create policy "group owners and site owner update group details" on public.community_groups
  for update to authenticated using (
    owner_id = (select auth.uid()) or public.is_portfolio_owner()
  ) with check (
    owner_id = (select auth.uid()) or public.is_portfolio_owner()
  );
drop policy if exists "group owners and site owner delete groups" on public.community_groups;
create policy "group owners and site owner delete groups" on public.community_groups
  for delete to authenticated using (
    owner_id = (select auth.uid()) or public.is_portfolio_owner()
  );

drop policy if exists "users and group owners read memberships" on public.community_group_members;
create policy "users and group owners read memberships" on public.community_group_members
  for select to authenticated using (
    user_id = (select auth.uid())
    or public.is_portfolio_owner()
    or exists (
      select 1 from public.community_groups groups
      where groups.id = community_group_members.group_id
        and groups.owner_id = (select auth.uid())
    )
  );
drop policy if exists "users join public groups as members" on public.community_group_members;
create policy "users join public groups as members" on public.community_group_members
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and role = 'member'
    and exists (
      select 1 from public.community_groups groups
      where groups.id = community_group_members.group_id
        and groups.visibility = 'public'
        and groups.owner_id <> (select auth.uid())
    )
  );
drop policy if exists "members leave groups" on public.community_group_members;
create policy "members leave groups" on public.community_group_members
  for delete to authenticated using (
    user_id = (select auth.uid()) and role = 'member'
  );

drop policy if exists "requesters and owners read group requests" on public.community_group_join_requests;
create policy "requesters and owners read group requests" on public.community_group_join_requests
  for select to authenticated using (
    user_id = (select auth.uid())
    or public.is_portfolio_owner()
    or exists (
      select 1 from public.community_groups groups
      where groups.id = community_group_join_requests.group_id
        and groups.owner_id = (select auth.uid())
    )
  );
drop policy if exists "users request private group access" on public.community_group_join_requests;
create policy "users request private group access" on public.community_group_join_requests
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and not exists (
      select 1 from public.community_group_members members
      where members.group_id = community_group_join_requests.group_id
        and members.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.community_groups groups
      where groups.id = community_group_join_requests.group_id
        and groups.visibility = 'private'
        and groups.owner_id <> (select auth.uid())
    )
  );

drop policy if exists "users and site owner delete community avatars" on storage.objects;
create policy "users and site owner delete community avatars" on storage.objects
  for delete to authenticated using (
    bucket_id = 'community-avatars'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or public.is_portfolio_owner()
    )
  );

drop policy if exists "only group members read group messages" on public.community_group_messages;
create policy "only group members read group messages" on public.community_group_messages
  for select to authenticated using (public.is_community_group_member(group_id));
drop policy if exists "members send messages as themselves" on public.community_group_messages;
create policy "members send messages as themselves" on public.community_group_messages
  for insert to authenticated with check (
    sender_id = (select auth.uid())
    and public.is_community_group_member(group_id)
  );
drop policy if exists "members and site owner moderate group messages" on public.community_group_messages;
create policy "members and site owner moderate group messages" on public.community_group_messages
  for delete to authenticated using (
    (sender_id = (select auth.uid()) and public.is_community_group_member(group_id))
    or public.is_portfolio_owner()
    or exists (
      select 1 from public.community_groups groups
      where groups.id = community_group_messages.group_id
        and groups.owner_id = (select auth.uid())
    )
  );

drop policy if exists "site owner moderates all community posts" on public.community_posts;
create policy "site owner moderates all community posts" on public.community_posts
  for delete to authenticated using (public.is_portfolio_owner());
drop policy if exists "site owner moderates all community comments" on public.community_comments;
create policy "site owner moderates all community comments" on public.community_comments
  for delete to authenticated using (public.is_portfolio_owner());

revoke all on public.community_groups, public.community_group_members,
  public.community_group_join_requests, public.community_group_messages
  from anon, authenticated;
grant select, delete on public.community_groups to authenticated;
grant insert (owner_id, name, description, visibility, avatar_path)
  on public.community_groups to authenticated;
grant update (name, description, visibility, avatar_path)
  on public.community_groups to authenticated;
grant select, insert, delete on public.community_group_members to authenticated;
grant select, insert on public.community_group_join_requests to authenticated;
grant select, insert, delete on public.community_group_messages to authenticated;

revoke execute on function public.is_community_group_member(uuid) from public, anon;
grant execute on function public.is_community_group_member(uuid) to authenticated;
revoke execute on function public.community_group_member_counts(uuid[]) from public, anon;
grant execute on function public.community_group_member_counts(uuid[]) to authenticated;
revoke execute on function public.request_community_group_join(uuid) from public, anon;
grant execute on function public.request_community_group_join(uuid) to authenticated;
revoke execute on function public.decide_community_group_join_request(uuid, boolean) from public, anon;
grant execute on function public.decide_community_group_join_request(uuid, boolean) to authenticated;
revoke execute on function public.remove_community_group_member(uuid, uuid) from public, anon;
grant execute on function public.remove_community_group_member(uuid, uuid) to authenticated;
revoke execute on function public.add_community_group_owner_as_member() from public, anon, authenticated;
revoke execute on function public.reset_community_group_request_on_leave() from public, anon, authenticated;
revoke execute on function public.touch_community_group_updated_at() from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_groups'
  ) then
    alter publication supabase_realtime add table public.community_groups;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_group_members'
  ) then
    alter publication supabase_realtime add table public.community_group_members;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_group_join_requests'
  ) then
    alter publication supabase_realtime add table public.community_group_join_requests;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'community_group_messages'
  ) then
    alter publication supabase_realtime add table public.community_group_messages;
  end if;
end
$$;

commit;
