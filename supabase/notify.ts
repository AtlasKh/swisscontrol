// ============================================================
// SwissControl: уведомления об изменениях в графике + файлы программ в Telegram (версия 1.22)
// Supabase → Edge Functions → Deploy a new function → Via Editor.
// Имя функции: notify. Вставьте ВЕСЬ этот текст вместо примера и нажмите Deploy.
// Нужен секрет TELEGRAM_BOT_TOKEN (Edge Functions → Secrets).
// В настройках функции выключите «Verify JWT» (Enforce JWT verification).
// ============================================================

const OWNER_ID = 381731875;                         // владелец (админ)
const EDIT_ROLES = ['setter'];                      // кто ещё может менять график
const FILE_ROLES = ['setter', 'operator', 'qc', 'manager'];   // кто может получать файлы программ (себе в чат)
const APP_URL_DEFAULT = 'https://atlaskh.github.io/swisscontrol/?open=schedule';   // сразу на вкладку «График»
const MAX_AGE_SEC = 7 * 24 * 3600;                  // подпись Telegram действует не дольше недели
const DAY_START = 6, NIGHT_START = 18;

const env = (k: string): string => ((globalThis as any).Deno ? (globalThis as any).Deno.env.get(k) : (globalThis as any).process.env[k]) || '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const SAFE_ID = /^[A-Za-z0-9_-]+$/, ISO = /^\d{4}-\d{2}-\d{2}$/, SHIFTS = ['', 'd', 'n'];

// ---------- проверка подписи Telegram (initData) ----------
const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
async function checkInitData(initData: string, botToken: string) {
  const p = new URLSearchParams(initData || '');
  const hash = p.get('hash');
  if (!hash) throw new Error('нет подписи Telegram — откройте приложение через бота');
  const pairs: string[] = [];
  p.forEach((v, k) => { if (k !== 'hash') pairs.push(k + '=' + v); });
  pairs.sort();
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const calc = hex(await hmac(secret, pairs.join('\n')));
  if (calc !== hash) throw new Error('подпись Telegram не сходится');
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (!(age < MAX_AGE_SEC)) throw new Error('подпись Telegram устарела — закройте и снова откройте приложение');
  const user = JSON.parse(p.get('user') || 'null');
  if (!user || !user.id) throw new Error('в подписи нет пользователя');
  return user as { id: number; first_name?: string };
}

// ---------- база ----------
async function db(path: string) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_ANON_KEY');
  const h: Record<string, string> = { apikey: key };
  if (key.startsWith('eyJ')) h.Authorization = 'Bearer ' + key;
  const r = await fetch(env('SUPABASE_URL').replace(/\/+$/, '') + '/rest/v1/' + path, { headers: h });
  if (!r.ok) throw new Error('база: ' + r.status + ' ' + (await r.text()).slice(0, 150));
  return await r.json();
}

// ---------- текст сообщения ----------
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const hh = (h: number) => String(h).padStart(2, '0') + ':00';
function shiftText(s: string, bold: boolean) {
  const b = (t: string) => (bold ? '<b>' + t + '</b>' : t);
  if (s === 'd') return '☀️ ' + b('день') + (bold ? ' ' + hh(DAY_START) + '–' + hh(NIGHT_START) : '');
  if (s === 'n') return '🌙 ' + b('ночь') + (bold ? ' ' + hh(NIGHT_START) + '–' + hh(DAY_START) : '');
  return '🏠 ' + b('выходной');
}
function dayText(iso: string) {
  const [y, m, d] = iso.split('-');
  return d + '.' + m + ' (' + WD[new Date(Date.UTC(+y, +m - 1, +d)).getUTCDay()] + ')';
}
export function buildMessage(list: { day: string; from: string; to: string }[]) {
  const rows = list.slice().sort((a, b) => (a.day < b.day ? -1 : 1))
    .map(c => '• ' + dayText(c.day) + ' — ' + shiftText(c.to, true) + ' <i>(было: ' + shiftText(c.from, false).replace(/^\S+ /, '') + ')</i>');
  return '📅 <b>Изменения в вашем графике</b>\n\n' + rows.join('\n') + '\n\nВесь график — в приложении SwissControl.';
}

async function tgSend(token: string, chatId: number, text: string, appUrl: string) {
  const call = async (markup: unknown) => {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) })
    });
    return await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  };
  let res = appUrl ? await call({ inline_keyboard: [[{ text: '📅 Открыть график', web_app: { url: appUrl } }]] }) : await call(null);
  if (!res.ok && appUrl && /button|web_app|BUTTON/i.test(res.description || '')) res = await call(null);   // кнопка не прошла — шлём без неё
  return res;
}

// ---------- файл программы: бот присылает его самому человеку (для флешки) ----------
const FILE_NAME = /^O\d{1,8}(\.(NC|TXT|nc|txt))?$/;
const FILE_TEXT = /^[\x09\x0A\x0D\x20-\x7E]*$/;          // станку — только латиница, цифры и знаки
async function sendFile(user: { id: number }, body: any, token: string): Promise<Response> {
  if (Number(user.id) !== OWNER_ID) {
    const u = await db('users?select=role&id=eq.' + encodeURIComponent(String(user.id)));
    if (!u.length || !FILE_ROLES.includes(u[0].role)) return json({ error: 'нет доступа — дождитесь, пока админ одобрит заявку' }, 403);
  }
  const name = String(body.name || ''), text = String(body.content || '');
  if (!FILE_NAME.test(name)) return json({ error: 'имя файла должно быть вида O1234' }, 400);
  if (!text.length || text.length > 200000) return json({ error: 'файл пустой или слишком большой' }, 400);
  if (!FILE_TEXT.test(text)) return json({ error: 'в программе есть русские буквы или спецсимволы — станок их не прочитает' }, 400);
  const fd = new FormData();
  fd.append('chat_id', String(user.id));
  fd.append('document', new Blob([text], { type: 'text/plain' }), name);
  fd.append('caption', '📄 ' + name + ' — скачайте файл и скопируйте на флешку');
  const r = await fetch('https://api.telegram.org/bot' + token + '/sendDocument', { method: 'POST', body: fd });
  const res = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!res.ok) return json({ error: /blocked|chat not found|initiate/i.test(res.description || '') ? 'бот не может написать вам — нажмите «Старт» в чате с ботом' : String(res.description || 'ошибка Telegram') }, 502);
  return json({ ok: true });
}

// ---------- обработчик ----------
export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'нужен POST' }, 405);
  const token = env('TELEGRAM_BOT_TOKEN');
  if (!token) return json({ error: 'в Supabase не задан секрет TELEGRAM_BOT_TOKEN' }, 500);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'неверный запрос' }, 400); }

  let user;
  try { user = await checkInitData(String(body.initData || ''), token); }
  catch (e) { return json({ error: (e as Error).message }, 401); }

  try {
    if (body.action === 'file') return await sendFile(user, body, token);
    if (Number(user.id) !== OWNER_ID) {
      const u = await db('users?select=role&id=eq.' + encodeURIComponent(String(user.id)));
      if (!u.length || !EDIT_ROLES.includes(u[0].role)) return json({ error: 'нет прав на изменение графика' }, 403);
    }
    const changes = (Array.isArray(body.changes) ? body.changes : []).filter((c: any) => c &&
      SAFE_ID.test(String(c.staff_id)) && ISO.test(String(c.day)) && SHIFTS.includes(c.from ?? '') && SHIFTS.includes(c.to ?? '') && (c.from ?? '') !== (c.to ?? ''));
    if (!changes.length) return json({ sent: [], noLink: [], failed: [], skipped: 0 });
    if (changes.length > 500) return json({ error: 'слишком много изменений за раз' }, 400);

    const sids = [...new Set(changes.map((c: any) => c.staff_id))] as string[];
    const days = [...new Set(changes.map((c: any) => c.day))] as string[];
    const staff = await db('staff?select=id,name,tg_id&id=in.(' + sids.join(',') + ')');
    const roster = await db('roster?select=staff_id,day,shift&staff_id=in.(' + sids.join(',') + ')&day=in.(' + days.join(',') + ')');
    const now: Record<string, string> = {};
    for (const r of roster) now[r.day + '_' + r.staff_id] = r.shift;

    // уведомляем только о том, что действительно сохранено в базе
    const by: Record<string, any[]> = {};
    let skipped = 0;
    for (const c of changes) {
      if ((now[c.day + '_' + c.staff_id] || '') !== (c.to || '')) { skipped++; continue; }
      (by[c.staff_id] = by[c.staff_id] || []).push({ day: c.day, from: c.from || '', to: c.to || '' });
    }
    const appUrl = env('APP_URL') || APP_URL_DEFAULT;
    const sent: string[] = [], noLink: string[] = [], failed: { name: string; reason: string }[] = [];
    for (const s of staff) {
      const list = by[s.id]; if (!list) continue;
      if (s.tg_id == null) { noLink.push(s.name); continue; }
      const res = await tgSend(token, Number(s.tg_id), buildMessage(list), appUrl);
      if (res.ok) sent.push(s.name);
      else failed.push({ name: s.name, reason: /blocked|chat not found|initiate/i.test(res.description || '') ? 'не запускал бота или заблокировал его' : String(res.description || 'ошибка') });
    }
    return json({ sent, noLink, failed, skipped });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

if ((globalThis as any).Deno) (globalThis as any).Deno.serve(handler);
