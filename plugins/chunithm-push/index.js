// 中二节奏情报推送 —— Plugin
//
// 定时检查两个公开数据源，有新内容就推到白名单群：
//   · 官方网站新闻 API（稳定）
//   · 官方 X @chunithm（走 FxTwitter 的 v2 时间线，偶尔慢/失败）
//
// 为什么不直接调 onebot.sendText：
//   · 插件 API 没有暴露 sender / onebot；
//   · QQ Agent 的本地控制台有一个带白名单校验的 /api/chats/group_<id>/test-send，
//     它内部会 onebot.sendText + store.appendSelf + emit('chat-update') ——
//     等于复用宿主已有的发送和存档路径，下一次运行她知道这条是自己发的。
//   · 代价是不经过 SendQueue 的分钟/小时限频（本插件每轮最多发一条，不会刷屏）。
//
// 状态文件写在 data/：写在插件目录里会触发热重载（fs.watch plugins/ recursive）。

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { getConfig, DATA_DIR } from '../../src/config.js';

// 与技能一致：IPv6 出口不通时，IPv6 优先会让 X 抓取白卡十几秒。
// 只调整解析顺序，不关 IPv6；IPv4 失败仍会回落。
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 老 Node 没有这个 API */ }

const PLUGIN_ID = 'chunithm-push';
const SITE_NEWS_API = 'https://info-chunithm.sega.jp/wp-json/thistheme/v1/articlesRest';
const X_TIMELINE_API = 'https://api.fxtwitter.com/2/profile/chunithm/statuses?count=20&with_media=false';
const X_PROFILE = 'chunithm';
const STATE_FILE = path.join(DATA_DIR, 'chunithm-push-state.json');
const MAX_SEEN = 500;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const SEND_FAIL_RETRY_MS = 3 * 60 * 1000;

const DEFAULTS = {
  enabled: true,
  groupIds: '',
  intervalMinutes: 15,
  includeX: true,
  includeSite: true,
  maxPerPush: 5,
  firstRunPush: false,
  quietStart: 1,
  quietEnd: 7
};

let api = null;
let log = () => {};
let warn = () => {};
let timer = null;
let active = false;
let running = false;
let nextRunAt = 0;
let state = defaultState();

function defaultState() {
  return {
    seenX: [],
    seenSite: [],
    initX: false,
    initSite: false,
    lastCheckAt: 0,
    lastPushAt: 0,
    lastPushCount: 0,
    lastError: '',
    lastWarn: '',
    lastSkip: ''
  };
}

/* ── 配置与目标群 ────────────────────────────────────────────────────── */

const clampNum = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function settings() {
  let raw = {};
  try {
    raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,
    groupIds: String(raw.groupIds ?? ''),
    intervalMinutes: clampNum(raw.intervalMinutes, DEFAULTS.intervalMinutes, 5, 360),
    includeX: raw.includeX !== false,
    includeSite: raw.includeSite !== false,
    maxPerPush: clampNum(raw.maxPerPush, DEFAULTS.maxPerPush, 1, 10),
    firstRunPush: raw.firstRunPush === true,
    quietStart: clampNum(raw.quietStart, DEFAULTS.quietStart, 0, 23),
    quietEnd: clampNum(raw.quietEnd, DEFAULTS.quietEnd, 0, 23)
  };
}

const parseIds = (s) => [...new Set(String(s ?? '')
  .split(/[,，;；\s]+/)
  .map((x) => x.replace(/[^0-9]/g, ''))
  .filter(Boolean))];

function targetGroups() {
  const s = settings();
  const explicit = parseIds(s.groupIds);
  const cfg = getConfig() || {};
  const allowList = cfg.allow?.groups ?? cfg.allow?.group ?? [];
  const allowed = parseIds(Array.isArray(allowList) ? allowList.join(',') : allowList);

  if (explicit.length) {
    if (!allowed.length) return explicit;
    return explicit.filter((id) => allowed.includes(id));
  }
  return allowed;
}

function inQuietHours(now, s) {
  if (s.quietStart === s.quietEnd) return false;
  const hour = new Date(now).getHours();
  return s.quietStart < s.quietEnd
    ? hour >= s.quietStart && hour < s.quietEnd
    : hour >= s.quietStart || hour < s.quietEnd;
}

/* ── 状态 ────────────────────────────────────────────────────────────── */

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const next = { ...defaultState(), ...(raw && typeof raw === 'object' ? raw : {}) };
    next.seenX = Array.isArray(next.seenX) ? next.seenX.map(String).slice(-MAX_SEEN) : [];
    next.seenSite = Array.isArray(next.seenSite) ? next.seenSite.map(String).slice(-MAX_SEEN) : [];
    next.initX = next.initX === true;
    next.initSite = next.initSite === true;
    return next;
  } catch {
    return defaultState();
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    warn(`状态保存失败（不影响下一轮检查）：${shortErr(error)}`);
  }
}

const uniqCap = (list) => [...new Set(list.map(String))].slice(-MAX_SEEN);

/* ── 小工具 ──────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const oneLine = (s) => String(s ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function shortErr(e) {
  return truncate(String(e?.message ?? e ?? '未知错误').replace(/\s+/g, ' '), 240);
}

function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/** 官网和 X 经常同时报同一件事，粗略判重，避免一轮推两条一样的。 */
function sameStory(a, b) {
  const na = normalizeText(`${a.title || ''}${a.text || ''}`);
  const nb = normalizeText(`${b.title || ''}${b.text || ''}`);
  if (!na || !nb) return false;
  if (na.includes(nb.slice(0, 50)) || nb.includes(na.slice(0, 50))) return true;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (!ba.size || !bb.size) return false;
  let common = 0;
  for (const x of ba) if (bb.has(x)) common += 1;
  return common / Math.min(ba.size, bb.size) >= 0.72;
}

function fmtBeijing(ts, withTime = true) {
  if (!Number.isFinite(ts) || ts <= 0) return '时间未知';
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

/* ── HTTP ────────────────────────────────────────────────────────────── */

function isRetryable(error) {
  if (!error?.status) return true;
  return error.status === 429 || error.status >= 500;
}

async function fetchJson(url, { headers = {}, timeout = 25000, retries = 1 } = {}) {
  const fetcher = api?.fetch;
  if (typeof fetcher !== 'function') throw new Error('插件没有拿到联网权限（web_fetch）');
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetcher(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'QQAgent-CHUNITHM-Push/1.0',
          ...headers
        },
        signal: AbortSignal.timeout(timeout)
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!res.ok) {
        const error = new Error(body?.message || `HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < retries && isRetryable(error)) {
        await sleep(900 + attempt * 900);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error('请求失败');
}

/* ── 数据源 ──────────────────────────────────────────────────────────── */

function parseSiteDate(raw) {
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(String(raw ?? ''));
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600 * 1000;
  const t = Date.parse(String(raw ?? ''));
  return Number.isFinite(t) ? t : 0;
}

async function fetchSiteNews() {
  const data = await fetchJson(SITE_NEWS_API, { timeout: 20000, retries: 1 });
  const list = Array.isArray(data) ? data : [];
  return list.map((a) => {
    const title = oneLine(a?.title);
    const desc = String(a?.desc ?? '').replace(/\r/g, '').trim();
    return {
      source: 'site',
      id: `site:${String(a?.permalink || title)}`,
      title,
      text: desc && normalizeText(desc) !== normalizeText(title) ? `${title}\n${desc}` : title,
      url: String(a?.permalink || ''),
      // 官网只给日本时间的日历日，原样用，免得转成北京时间差一天
      dateText: String(a?.date ?? ''),
      ts: parseSiteDate(a?.date)
    };
  }).filter((x) => x.title).sort((a, b) => b.ts - a.ts).slice(0, 100);
  // 官网接口会返回全部历史（400+ 条）。只取最近 100 条：
  // 定时推送用不到更早的，也避免 seenSite 超过上限后把古老条目当成"新"的重推。
}

function cleanXText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^\s*https:\/\/t\.co\//.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchXNews() {
  // 后台检查可以多等一会儿：单次 15 秒、最多 3 次（死连接换个连接通常就通了）。
  const data = await fetchJson(X_TIMELINE_API, { timeout: 15000, retries: 2 });
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => r && r.type === 'status'
      && String(r.author?.screen_name ?? '').toLowerCase() === X_PROFILE)
    .map((r) => {
      const text = cleanXText(r.text);
      const first = oneLine(text.split('\n')[0] || text);
      return {
        source: 'x',
        id: `x:${String(r.id)}`,
        title: first,
        text,
        url: String(r.url || `https://x.com/${X_PROFILE}/status/${r.id}`),
        ts: Date.parse(r.created_at) || 0
      };
    })
    .sort((a, b) => b.ts - a.ts);
}

async function collectSources(s) {
  const jobs = [];
  if (s.includeSite) {
    jobs.push(fetchSiteNews()
      .then((items) => ({ source: 'site', items }))
      .catch((error) => ({ source: 'site', error })));
  }
  if (s.includeX) {
    jobs.push(fetchXNews()
      .then((items) => ({ source: 'x', items }))
      .catch((error) => ({ source: 'x', error })));
  }
  if (!jobs.length) return [{ source: 'none', error: new Error('两个数据源都被关掉了') }];
  return Promise.all(jobs);
}

/* ── 判断新内容 ──────────────────────────────────────────────────────── */

function collectNew(results, s) {
  const fresh = [];
  const allFetched = [];
  const warnings = [];

  for (const result of results) {
    const label = result.source === 'x' ? 'X' : '官网';
    if (result.error) {
      warnings.push(`${label}这次没取到：${shortErr(result.error)}`);
      continue;
    }
    const items = Array.isArray(result.items) ? result.items : [];
    allFetched.push(...items);

    const seenKey = result.source === 'x' ? 'seenX' : 'seenSite';
    const initKey = result.source === 'x' ? 'initX' : 'initSite';
    const seen = new Set(state[seenKey]);

    if (!state[initKey]) {
      state[initKey] = true;
      if (!s.firstRunPush) {
        state[seenKey] = uniqCap([...state[seenKey], ...items.map((i) => i.id)]);
        warnings.push(`${label}首次运行：已记录 ${items.length} 条旧情报，不补发`);
        continue;
      }
    }

    const newItems = items.filter((i) => !seen.has(String(i.id)));
    fresh.push(...newItems);
  }

  return { fresh, allFetched, warnings };
}

function pickStories(items, max) {
  const sorted = items.slice().sort((a, b) => b.ts - a.ts);
  const picked = [];
  for (const item of sorted) {
    if (picked.some((p) => sameStory(p, item))) continue;
    picked.push(item);
    if (picked.length >= max) break;
  }
  return picked;
}

/* ── 推送内容 ────────────────────────────────────────────────────────── */

function buildPushText(items, totalNew) {
  const lines = ['【CHUNITHM 官方新情报】'];
  for (const item of items) {
    const tag = item.source === 'x' ? 'X' : '官网';
    const when = item.source === 'site'
      ? (item.dateText || fmtBeijing(item.ts, false))
      : fmtBeijing(item.ts);
    lines.push(`・${when}｜${tag}`);
    lines.push(truncate(item.title || item.text, 140));
    if (item.url) lines.push(item.url);
    lines.push('');
  }
  if (totalNew > items.length) {
    lines.push(`还有 ${totalNew - items.length} 条新情报，去官网看：https://info-chunithm.sega.jp/`);
    lines.push('');
  }
  lines.push('（日文原文；要翻译或展开可以在群里问她）');
  return truncate(lines.join('\n').trim(), 1800);
}

/* ── 发送：走宿主控制台的本地发送接口（带白名单校验 + 写入聊天存档）── */

async function sendToGroup(groupId, text) {
  const fetcher = api?.fetch;
  if (typeof fetcher !== 'function') return { ok: false, error: '插件没有联网权限' };
  const cfg = getConfig() || {};
  const basePort = clampNum(cfg.server?.port, 3210, 1, 65535);
  const token = String(cfg.server?.token ?? '');
  let lastError = '控制台接口不可达';

  for (let port = basePort; port < basePort + 10; port += 1) {
    try {
      const res = await fetcher(`http://127.0.0.1:${port}/api/chats/group_${groupId}/test-send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-console-token': token } : {})
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) return { ok: true, port };
      lastError = `HTTP ${res.status}${body?.error ? `：${body.error}` : ''}`;
      // 401/403/5xx 是"找到了服务但发不出去"，换端口没有意义
      if (res.status === 401 || res.status === 403 || res.status >= 500) break;
    } catch (error) {
      lastError = shortErr(error);
    }
  }
  return { ok: false, error: lastError };
}

async function pushToGroups(groups, text) {
  const errors = [];
  let okCount = 0;
  for (const groupId of groups) {
    const result = await sendToGroup(groupId, text);
    if (result.ok) {
      okCount += 1;
      log(`已推送到群 ${groupId}（控制台端口 ${result.port}）`);
    } else {
      errors.push(`${groupId}：${result.error}`);
      warn(`推送到群 ${groupId} 失败：${result.error}`);
    }
    await sleep(700);
  }
  return { okCount, errors };
}

/* ── 一轮检查 ────────────────────────────────────────────────────────── */

async function checkOnce() {
  const s = settings();
  if (!s.enabled) return 'disabled';

  const groups = targetGroups();
  if (!groups.length) {
    state.lastCheckAt = Date.now();
    state.lastError = '没有可推送的群：请在插件设置里填群号，或先把群加进白名单';
    log(state.lastError);
    saveState();
    return 'no-groups';
  }

  const results = await collectSources(s);
  const { fresh, allFetched, warnings } = collectNew(results, s);
  state.lastCheckAt = Date.now();
  state.lastWarn = warnings.join('；');

  const okSources = results.filter((r) => !r.error).length;
  if (!okSources) {
    state.lastError = warnings.join('；') || '所有数据源都没取到';
    log(`本轮检查失败：${state.lastError}`);
    saveState();
    return 'sources-failed';
  }
  state.lastError = '';

  if (!fresh.length) {
    log(`本轮没有新情报${warnings.length ? `（${warnings.join('；')}）` : ''}`);
    saveState();
    return 'idle';
  }

  const selected = pickStories(fresh, s.maxPerPush);
  const text = buildPushText(selected, fresh.length);
  const push = await pushToGroups(groups, text);

  if (push.okCount > 0) {
    // 成功推送后把"这一轮抓到的全部 ID"都记为已读：
    // 只记 selected 的话，超出 maxPerPush 的旧条目下一轮会再被当成新内容。
    state.seenX = uniqCap([...state.seenX, ...allFetched.filter((i) => i.source === 'x').map((i) => i.id)]);
    state.seenSite = uniqCap([...state.seenSite, ...allFetched.filter((i) => i.source === 'site').map((i) => i.id)]);
    state.lastPushAt = Date.now();
    state.lastPushCount = selected.length;
    state.lastError = push.errors.length ? `部分群推送失败：${push.errors.join('；')}` : '';
    state.lastSkip = '';
    log(`已推送 ${selected.length} 条新情报到 ${push.okCount}/${groups.length} 个群`);
    saveState();
    return 'sent';
  }

  state.lastError = `推送失败：${push.errors.join('；') || '未知错误'}`;
  log(state.lastError);
  saveState();
  return 'send-failed';
}

/* ── 定时器 ──────────────────────────────────────────────────────────── */

function intervalMs() {
  return Math.max(5, Number(settings().intervalMinutes) || DEFAULTS.intervalMinutes) * 60 * 1000;
}

function schedule(delay) {
  if (!active) return;
  if (timer) clearTimeout(timer);
  nextRunAt = Date.now() + delay;
  timer = setTimeout(() => {
    tick().catch((error) => warn(`检查异常：${shortErr(error)}`));
  }, delay);
  timer.unref?.();
}

async function tick() {
  if (!active || running) return;
  running = true;
  let nextDelay = null;
  try {
    const s = settings();
    if (!s.enabled) return;
    if (inQuietHours(Date.now(), s)) {
      state.lastSkip = `安静时段（${s.quietStart}:00-${s.quietEnd}:00）`;
      log(`安静时段，跳过本轮检查`);
      return;
    }
    state.lastSkip = '';
    const result = await checkOnce();
    if (result === 'send-failed') nextDelay = SEND_FAIL_RETRY_MS;
  } catch (error) {
    state.lastError = shortErr(error);
    warn(`检查失败：${state.lastError}`);
    saveState();
  } finally {
    running = false;
    if (active) schedule(nextDelay ?? intervalMs());
  }
}

/* ── 生命周期 ────────────────────────────────────────────────────────── */

function ensureLogger() {
  log = (...args) => { try { api?.log?.(...args); } catch { /* ignore */ } };
  warn = (...args) => { try { api?.warn?.(...args); } catch { /* ignore */ } };
}

export function setup(a) {
  api = a;
  ensureLogger();
  state = loadState();
  active = true;
  const s = settings();
  log(`已加载：每 ${s.intervalMinutes} 分钟检查`
    + `｜数据源 ${[s.includeX ? 'X' : '', s.includeSite ? '官网' : ''].filter(Boolean).join(' + ')}`
    + `｜目标群 ${targetGroups().join('、') || '（未配置）'}`
    + `｜首次运行${s.firstRunPush ? '补发' : '不补发'}`);
  if (s.enabled) schedule(FIRST_CHECK_DELAY_MS);
}

export function available() {
  return settings().enabled !== false;
}

export function deactivate() {
  active = false;
  running = false;
  nextRunAt = 0;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function dispose() {
  deactivate();
}

export const providers = {
  'status.chunithm-push': () => {
    const s = settings();
    const groups = targetGroups();
    const now = Date.now();
    const ago = (ts) => {
      if (!ts) return '还没有';
      const sec = Math.max(0, Math.round((now - ts) / 1000));
      if (sec < 60) return `${sec} 秒前`;
      if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
      if (sec < 86400) return `${Math.round(sec / 3600)} 小时前`;
      return `${Math.round(sec / 86400)} 天前`;
    };
    return {
      icon: '📰',
      title: '中二节奏情报推送',
      priority: 58,
      lines: [
        ['状态', s.enabled ? (active ? '运行中' : '已停用') : '已关闭'],
        ['检查间隔', `${s.intervalMinutes} 分钟`],
        ['下次检查', active && nextRunAt ? `${ago(nextRunAt).replace('前', '后')}（约 ${fmtBeijing(nextRunAt, false)}）` : '未安排'],
        ['推送目标', groups.length ? groups.join('、') : '（没有可用群，请在设置里填群号）'],
        ['数据源', [s.includeSite ? '官网' : '', s.includeX ? '官方 X' : ''].filter(Boolean).join(' + ') || '（都关了）'],
        ['上次检查', ago(state.lastCheckAt)],
        ['上次推送', state.lastPushAt ? `${ago(state.lastPushAt)}（${state.lastPushCount} 条）` : '还没有'],
        ['已记录', `官网 ${state.seenSite.length} 条 / X ${state.seenX.length} 条`],
        ['安静时段', s.quietStart === s.quietEnd ? '关闭' : `${s.quietStart}:00 - ${s.quietEnd}:00`],
        ['最近提醒', state.lastWarn ? truncate(state.lastWarn, 160) : '无'],
        ['最近错误', state.lastError ? truncate(state.lastError, 160) : '无']
      ]
    };
  }
};

export const internals = {
  PLUGIN_ID,
  DEFAULTS,
  settings,
  targetGroups,
  inQuietHours,
  loadState,
  saveState,
  fetchSiteNews,
  fetchXNews,
  collectSources,
  collectNew,
  pickStories,
  buildPushText,
  sendToGroup,
  pushToGroups,
  checkOnce,
  sameStory,
  state: () => state
};
