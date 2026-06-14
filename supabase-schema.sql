create table if not exists public.tracking_tool_state (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.tracking_tool_state enable row level security;

grant select, insert, update on public.tracking_tool_state to anon;
grant select, insert, update on public.tracking_tool_state to authenticated;

drop policy if exists "tracking_tool_state_read" on public.tracking_tool_state;
drop policy if exists "tracking_tool_state_insert" on public.tracking_tool_state;
drop policy if exists "tracking_tool_state_update" on public.tracking_tool_state;

create policy "tracking_tool_state_read"
on public.tracking_tool_state for select
using (true);

create policy "tracking_tool_state_insert"
on public.tracking_tool_state for insert
with check (true);

create policy "tracking_tool_state_update"
on public.tracking_tool_state for update
using (true)
with check (true);
