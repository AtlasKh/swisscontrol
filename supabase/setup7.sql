-- ============================================================
-- SwissControl: запросы на смену («нужны люди») и ответы сотрудников (версия 1.23)
-- Вставьте ВЕСЬ текст в Supabase → SQL Editor → новая вкладка (+) → Run.
-- Запускать один раз, после setup2–setup6. Повторный запуск безопасен.
-- Существующие данные не затрагиваются.
-- ============================================================

-- Запрос: на какую дату и смену нужны люди
create table if not exists shift_requests (
  id          text primary key,
  day         date not null,
  shift       text not null check (shift in ('d', 'n')),          -- день / ночь
  need        int  not null default 1 check (need between 1 and 50), -- сколько человек нужно
  note        text,                                               -- комментарий (необязательно)
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_by  text,                                               -- кто создал (имя)
  created_tg  bigint,                                             -- его Telegram — сюда приходят ответы
  created_at  timestamptz not null default now()
);
create index if not exists shift_requests_day_idx on shift_requests(day);

-- Ответ сотрудника на запрос: смогу / не смогу
create table if not exists request_replies (
  id        text primary key,                                     -- «idЗапроса_idСотрудника»
  req_id    text not null references shift_requests(id) on delete cascade,
  staff_id  text not null references staff(id) on delete cascade,
  answer    text not null check (answer in ('yes', 'no')),
  at        timestamptz not null default now()
);
create index if not exists request_replies_req_idx on request_replies(req_id);

alter table shift_requests  enable row level security;
alter table request_replies enable row level security;
drop policy if exists "app access" on shift_requests;
drop policy if exists "app access" on request_replies;
create policy "app access" on shift_requests  for all to anon using (true) with check (true);
create policy "app access" on request_replies for all to anon using (true) with check (true);
grant select, insert, update, delete on shift_requests, request_replies to anon;

-- метка версии базы
insert into app_meta (key, value) values ('schema', '7')
  on conflict (key) do update set value = excluded.value where app_meta.value::int < 7;

notify pgrst, 'reload schema';
