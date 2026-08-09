-- 댄스스포츠 메트로놈 — 계정 동기화 스키마
--
-- 설계 메모
--   연습 기록을 "날짜별 합계"로 두면 폰과 아이패드에서 같은 날 연습했을 때
--   덮어쓰기(기록 손실)나 중복 합산 중 하나가 반드시 생긴다.
--   그래서 연습 조각을 append-only 로 쌓고, 합계는 읽을 때 계산한다.
--   각 조각의 id 를 기기에서 만들어 보내므로 같은 조각을 두 번 보내도 안전하다.
--
--   설정과 음원 목록은 하나뿐인 값이라 마지막 저장이 이기는 방식으로 둔다.
--
--   음원 파일 자체와 녹음한 목소리는 올리지 않는다. 용량이 크고,
--   저작권 있는 음원을 서버에 두는 일도 피하는 게 맞다. 폰에만 남는다.

-- ---------------------------------------------------------------- 연습 기록
create table if not exists public.practice_sessions (
  id          uuid        primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  day         date        not null,
  dance_id    text,
  seconds     integer     not null check (seconds > 0 and seconds <= 86400),
  created_at  timestamptz not null default now()
);

create index if not exists practice_sessions_user_day_idx
  on public.practice_sessions (user_id, day);

alter table public.practice_sessions enable row level security;

drop policy if exists "own sessions" on public.practice_sessions;
create policy "own sessions" on public.practice_sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 날짜별·종목별 합계. 앱은 이것만 읽으면 된다.
create or replace view public.practice_totals
with (security_invoker = true) as
  select user_id,
         day,
         sum(seconds)::integer                      as total_seconds,
         coalesce(
           jsonb_object_agg(dance_id, dance_seconds)
             filter (where dance_id is not null),
           '{}'::jsonb
         )                                          as by_dance
  from (
    select user_id, day, dance_id, sum(seconds)::integer as dance_seconds
    from public.practice_sessions
    group by user_id, day, dance_id
  ) per_dance
  group by user_id, day;

-- ---------------------------------------------------------------- 설정
create table if not exists public.settings (
  user_id     uuid        primary key references auth.users (id) on delete cascade,
  data        jsonb       not null default '{}'::jsonb,
  goal_seconds integer    not null default 1800,
  updated_at  timestamptz not null default now()
);

alter table public.settings enable row level security;

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- 음원 목록
-- 파일은 폰에 두고, 곡을 다시 불러왔을 때 다시 정렬하지 않아도 되도록
-- 템포·다운비트 같은 정렬 정보만 계정에 남긴다.
create table if not exists public.tracks (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  id          text        not null,
  name        text        not null,
  dance_id    text,
  bpm         double precision not null,
  offset_sec  double precision not null default 0,
  start_bar   integer     not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.tracks enable row level security;

drop policy if exists "own tracks" on public.tracks;
create policy "own tracks" on public.tracks
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

drop trigger if exists tracks_touch on public.tracks;
create trigger tracks_touch before update on public.tracks
  for each row execute function public.touch_updated_at();
