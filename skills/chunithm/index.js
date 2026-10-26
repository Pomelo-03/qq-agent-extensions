// 中二节奏情报站 —— Skill
//
// 三个工具，全部只查资料、不发消息：
//   chunithm__news    官方 X @chunithm + 官方网站最新公告
//   chunithm__song    落雪 LXNS 曲目库（定数/谱师/物量/别名）
//   chunithm__player  落雪 LXNS 查分（QQ / 好友码）
//
// 数据源约定（用户明确要求）：
//   · 曲目与成绩 → 落雪 LXNS（https://maimai.lxns.net），不用水鱼。
//   · 官方情报   → X @chunithm + info-chunithm.sega.jp。
//
// 两个关键约束：
//   1. X 直连被墙，走 FxTwitter 的时间线接口；它会抽风，所以官网永远并行抓，
//      X 失败时只给官网结果并说明。
//   2. 落雪查分需要开发者 API 密钥（Authorization 头），没有密钥时返回申请指引，
//      不要让模型假装查到了成绩。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';

// 这台机器的 IPv6 出口不通，而 api.fxtwitter.com 有 AAAA 记录；
// 系统默认会先试 IPv6，白白卡 10~20 秒才回落。把 IPv4 排前面只改解析顺序，
// IPv4 失败时仍会回落到 IPv6。
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* 老 Node 没有这个 API */ }

const SKILL_ID = 'chunithm';
const API_BASE = 'https://maimai.lxns.net/api/v0';
const SITE_NEWS_API = 'https://info-chunithm.sega.jp/wp-json/thistheme/v1/articlesRest';
// FxTwitter 的 v2 时间线：比 x.com 直连稳定，但偶发很慢（实测 2~45 秒）。
// with_media=false 把响应从 ~93KB 压到 ~11KB，命中率明显高很多；
// 我们只要文字和链接，媒体字段本来也用不上。
const X_TIMELINE_API = 'https://api.fxtwitter.com/2/profile/chunithm/statuses?count=20&with_media=false';
const X_PROFILE = 'chunithm';

// 缓存写在系统临时目录：技能目录里的任何写入都会触发 QQ Agent 热重载。
const CACHE_FILE = path.join(os.tmpdir(), 'qqa-chunithm-song-cache-v1.json');
const SONG_TTL_MS = 6 * 60 * 60 * 1000;
const NEWS_TTL_MS = 5 * 60 * 1000;

const DIFF_NAMES = ['BASIC', 'ADVANCED', 'EXPERT', 'MASTER', 'ULTIMA', "WORLD'S END"];
const RANK_NAMES = {
  sssp: 'SSS+', sss: 'SSS', ssp: 'SS+', ss: 'SS', sp: 'S+', s: 'S',
  aaa: 'AAA', aa: 'AA', a: 'A', bbb: 'BBB', bb: 'BB', b: 'B', c: 'C', d: 'D'
};
const CLEAR_NAMES = {
  catastrophy: 'CATASTROPHY', absolute: 'ABSOLUTE', brave: 'BRAVE',
  hard: 'HARD', clear: 'CLEAR', failed: 'FAILED'
};
const FC_NAMES = { alljusticecritical: 'AJC', alljustice: 'AJ', fullcombo: 'FC' };
const CHAIN_NAMES = { fullchain: '铂FC', fullchain2: '金FC' };

let apiRef = null;
let log = () => {};

const newsCache = { x: [], xAt: 0, site: [], siteAt: 0 };
let songCache = null;

/* ── 小工具 ──────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function settings() {
  try {
    return (apiRef?.config?.() || {});
  } catch {
    return {};
  }
}

const oneLine = (s) => String(s ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function shortErr(e) {
  return truncate(String(e?.message ?? e ?? '未知错误').replace(/\s+/g, ' '), 220);
}

function normalizeSearch(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 站内日期是日本时间（UTC+9）的日历日，只需要用于排序。 */
function parseSiteDate(raw) {
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(String(raw ?? ''));
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 9 * 3600 * 1000;
  const t = Date.parse(String(raw ?? ''));
  return Number.isFinite(t) ? t : 0;
}

/** 统一显示成北京时间，避免依赖运行环境的本地时区。 */
function fmtBeijing(ts, withTime = true) {
  if (!Number.isFinite(ts) || ts <= 0) return '时间未知';
  const d = new Date(ts + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

function fmtNumber(v, digits = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return digits == null ? String(n) : n.toFixed(digits);
}

/* ── HTTP ────────────────────────────────────────────────────────────── */

function isRetryable(error) {
  if (!error?.status) return true;                 // 网络层错误 / 超时
  return error.status === 429 || error.status >= 500;
}

async function fetchJson(url, { headers = {}, timeout = 25000, retries = 1 } = {}) {
  const fetcher = apiRef?.fetch;
  if (typeof fetcher !== 'function') throw new Error('技能没有拿到联网权限（web_fetch）');
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetcher(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'QQAgent-CHUNITHM/1.0',
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
        error.code = body?.code ?? res.status;
        error.body = body;
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

/* ── 官方情报 ────────────────────────────────────────────────────────── */

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
      text: desc && normalizeSearch(desc) !== normalizeSearch(title) ? `${title}\n${desc}` : title,
      url: String(a?.permalink || ''),
      // 官网只给日历日（日本时间），原样显示；转成北京时间反而会差一天
      dateText: String(a?.date ?? ''),
      ts: parseSiteDate(a?.date)
    };
  }).filter((x) => x.title).sort((a, b) => b.ts - a.ts);
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
  // FxTwitter 有时会卡在一条死连接上（0 字节直到超时），换个连接重试通常几秒就回。
  // 前台：单次 10 秒、最多 3 次，最坏 ~34 秒；官网结果照常并行返回。
  const data = await fetchJson(X_TIMELINE_API, { timeout: 10000, retries: 2 });
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

/**
 * 取最新情报。官网和 X 并行抓：X 慢/挂的时候官网仍然能出结果。
 * 返回值里的 warnings 会原样拼到工具结果末尾，让模型能说明哪一路没取到。
 */
async function getNews(source = 'all', limit = 10) {
  const src = ['all', 'x', 'official'].includes(source) ? source : 'all';
  const wantX = src !== 'official';
  const wantSite = src !== 'x';
  const now = Date.now();
  const warnings = [];

  const xStale = wantX && (now - newsCache.xAt > NEWS_TTL_MS || !newsCache.x.length);
  const siteStale = wantSite && (now - newsCache.siteAt > NEWS_TTL_MS || !newsCache.site.length);

  const [xResult, siteResult] = await Promise.allSettled([
    xStale ? fetchXNews() : Promise.resolve(null),
    siteStale ? fetchSiteNews() : Promise.resolve(null)
  ]);

  if (xResult.status === 'fulfilled' && xResult.value) {
    newsCache.x = xResult.value;
    newsCache.xAt = Date.now();
  } else if (xResult.status === 'rejected') {
    warnings.push(`X 这次没取到：${shortErr(xResult.reason)}`);
  }
  if (siteResult.status === 'fulfilled' && siteResult.value) {
    newsCache.site = siteResult.value;
    newsCache.siteAt = Date.now();
  } else if (siteResult.status === 'rejected') {
    warnings.push(`官网这次没取到：${shortErr(siteResult.reason)}`);
  }

  let items = [];
  if (wantX) items = items.concat(newsCache.x || []);
  if (wantSite) items = items.concat(newsCache.site || []);
  items.sort((a, b) => b.ts - a.ts);
  const max = Math.max(1, Math.min(20, Number(limit) || 10));
  items = items.slice(0, max);

  if (!items.length) {
    throw new Error(warnings.length ? warnings.join('；') : '没有取到任何官方情报');
  }
  return { items, warnings };
}

function formatNews({ items, warnings }) {
  const out = ['【CHUNITHM 官方最新情报】（日文原文，按时间倒序）'];
  items.forEach((it, i) => {
    const tag = it.source === 'x' ? 'X' : '官网';
    const when = it.source === 'site'
      ? (it.dateText || fmtBeijing(it.ts, false))
      : fmtBeijing(it.ts);
    out.push(`${i + 1}. [${tag}] ${when}`);
    out.push(truncate(it.text || it.title, 520));
    if (it.url) out.push(it.url);
    out.push('');
  });
  if (warnings.length) {
    out.push(`（注意：${warnings.join('；')}。回答时说明这一路暂时没取到。）`);
  } else {
    out.push('（来源：X @chunithm / 中二节奏官方网站。回答时请翻译或概括成中文，并保留链接。）');
  }
  return out.join('\n').trim();
}

/* ── 曲目库 ──────────────────────────────────────────────────────────── */

/**
 * 落雪把 WORLD'S END 谱面挂在单独的「曲目」里（id 8xxx，只有 difficulty 5，
 * level_value 恒为 0，真正的定级是 star 星级），origin_id 指回原曲。
 * 不合并的话，按标题/别名搜会一次冒出两三条同名的，WE 那条还会显示「定数 0」。
 */
function mergeWorldsEnd(data) {
  const songs = Array.isArray(data?.songs) ? data.songs : [];
  const byId = new Map(songs.map((s) => [Number(s.id), s]));
  const movedAlias = new Map();
  const removeIds = new Set();

  for (const song of songs) {
    const diffs = Array.isArray(song.difficulties) ? song.difficulties : [];
    // 只处理「单谱面且是 WE」的容器条目；原曲自己的 WE 谱面不动
    if (diffs.length !== 1 || Number(diffs[0]?.difficulty) !== 5) continue;
    const originId = Number(diffs[0]?.origin_id);
    const origin = byId.get(originId);
    if (!origin || origin === song) continue;
    const target = Array.isArray(origin.difficulties) ? origin.difficulties : (origin.difficulties = []);
    if (!target.some((d) => Number(d?.difficulty) === 5)) target.push({ ...diffs[0] });
    removeIds.add(Number(song.id));
    movedAlias.set(Number(song.id), originId);
  }

  if (!removeIds.size) return data;
  const aliases = (data.aliases || []).map((row) => (
    movedAlias.has(Number(row?.song_id))
      ? { ...row, song_id: movedAlias.get(Number(row.song_id)) }
      : row
  ));
  return { ...data, songs: songs.filter((s) => !removeIds.has(Number(s.id))), aliases };
}

async function getSongData() {
  const now = Date.now();
  if (songCache && now - songCache.at < SONG_TTL_MS) return songCache.data;

  if (!songCache) {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(raw?.data?.songs) && raw.data.songs.length) {
        songCache = { at: Number(raw.at) || 0, data: mergeWorldsEnd(raw.data) };
      }
    } catch { /* 没有缓存 */ }
  }
  if (songCache && now - songCache.at < SONG_TTL_MS) return songCache.data;

  const [songsResult, aliasResult] = await Promise.allSettled([
    fetchJson(`${API_BASE}/chunithm/song/list?notes=true`, { timeout: 30000, retries: 1 }),
    fetchJson(`${API_BASE}/chunithm/alias/list`, { timeout: 20000, retries: 1 })
  ]);

  if (songsResult.status !== 'fulfilled' || !Array.isArray(songsResult.value?.songs)) {
    if (songCache?.data?.songs?.length) {
      log(`[${SKILL_ID}] 曲目库刷新失败，继续用 ${fmtBeijing(songCache.at)} 的缓存：${shortErr(songsResult.reason)}`);
      return songCache.data;
    }
    throw new Error(`曲目库获取失败：${shortErr(songsResult.reason)}`);
  }

  const payload = songsResult.value;
  const data = mergeWorldsEnd({
    songs: payload.songs,
    versions: Array.isArray(payload.versions) ? payload.versions : [],
    genres: Array.isArray(payload.genres) ? payload.genres : [],
    aliases: aliasResult.status === 'fulfilled' && Array.isArray(aliasResult.value?.aliases)
      ? aliasResult.value.aliases
      : (songCache?.data?.aliases || [])
  });
  songCache = { at: Date.now(), data };
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: songCache.at, data }), 'utf8');
  } catch (error) {
    log(`[${SKILL_ID}] 曲目缓存写入失败（不影响查询）：${shortErr(error)}`);
  }
  return data;
}

function parseDifficulty(raw) {
  const s = String(raw ?? '').normalize('NFKC').toLowerCase().replace(/[\s'’]/g, '');
  if (!s) return null;
  if (/^[0-5]$/.test(s)) return Number(s);
  const map = {
    basic: 0, 绿: 0, advanced: 1, adv: 1, 黄: 1,
    expert: 2, exp: 2, 红: 2, master: 3, mas: 3, 紫: 3,
    ultima: 4, ult: 4, 黑: 4,
    worldsend: 5, 'world\'send': 5, we: 5, 白: 5
  };
  return map[s] ?? null;
}

function searchSongs(data, query, limit = 5) {
  const raw = String(query ?? '').trim();
  const q = normalizeSearch(raw);
  if (!q) return [];

  const aliasMap = new Map();
  for (const row of data.aliases || []) {
    const id = Number(row?.song_id);
    const list = Array.isArray(row?.aliases) ? row.aliases : [];
    // WE 合并后同一首歌可能有多行别名，拼起来而不是互相覆盖
    aliasMap.set(id, (aliasMap.get(id) || []).concat(list));
  }
  const tokens = raw.split(/\s+/).map(normalizeSearch).filter(Boolean);
  const idNumber = /^\d+$/.test(raw) ? Number(raw) : null;
  const hits = [];

  for (const song of data.songs || []) {
    const title = normalizeSearch(song.title);
    const artist = normalizeSearch(song.artist);
    const aliases = (aliasMap.get(Number(song.id)) || []).map(normalizeSearch);
    let score = 0;

    if (idNumber != null && Number(song.id) === idNumber) score = 1000;
    else if (title === q) score = 600;
    else if (aliases.includes(q)) score = 560;
    else if (title.startsWith(q)) score = 460;
    else if (title.includes(q)) score = 360;
    else if (aliases.some((a) => a.includes(q))) score = 310;
    else if (artist.includes(q)) score = 220;
    else if (title.length >= 3 && q.includes(title)) score = 160;
    else if (tokens.length > 1 && tokens.every((t) => title.includes(t) || aliases.some((a) => a.includes(t)) || artist.includes(t))) score = 260;

    if (score > 0) hits.push({ song, score, aliases: aliasMap.get(Number(song.id)) || [] });
  }

  hits.sort((a, b) => b.score - a.score || String(a.song.title).localeCompare(String(b.song.title), 'ja'));
  return hits.slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
}

function formatSong(hit, data, difficultyIndex) {
  const song = hit.song;
  const versionMap = new Map((data.versions || []).map((v) => [Number(v.version), v.title]));
  const version = versionMap.get(Number(song.version)) || (song.version ? `版本 ${song.version}` : '');
  const head = [
    `《${song.title}》${song.artist ? ` — ${song.artist}` : ''}`,
    `ID ${song.id}｜BPM ${song.bpm ?? '?'}${song.genre ? `｜分类 ${song.genre}` : ''}${version ? `｜版本 ${version}` : ''}`
  ];
  if (song.release_date) head.push(`国服配信：${song.release_date}`);
  if (hit.aliases.length) head.push(`别名：${hit.aliases.slice(0, 8).join(' / ')}`);

  const diffs = (song.difficulties || []).filter((d) => difficultyIndex == null || Number(d.difficulty) === difficultyIndex);
  if (!diffs.length) {
    head.push(difficultyIndex == null ? '（这个曲目没有谱面数据）' : `（这首没有 ${DIFF_NAMES[difficultyIndex] || difficultyIndex} 难度）`);
    return head.join('\n');
  }

  for (const d of diffs) {
    const name = DIFF_NAMES[Number(d.difficulty)] || `难度 ${d.difficulty}`;
    const level = String(d.level ?? '').trim();
    const value = Number(d.level_value);
    const isWe = Number(d.difficulty) === 5;
    // WE 没有定数：level_value 恒为 0，真正的难度是 star 星级 + 汉字属性
    const levelText = isWe
      ? (Number(d.star) > 0 ? `★${d.star}` : '星级未知')
      : Number.isFinite(value)
        ? (level && level !== fmtNumber(value) ? `${level}（定数 ${fmtNumber(value)}）` : `定数 ${fmtNumber(value)}`)
        : (level || '定数未知');
    const extras = [];
    if (isWe && d.kanji) extras.push(`属性「${d.kanji}」`);
    if (d.note_designer) extras.push(`谱师 ${d.note_designer}`);
    const notes = d.notes || {};
    const total = Number(notes.total);
    if (Number.isFinite(total) && total > 0) {
      const parts = [];
      for (const [key, label] of [['tap', 'TAP'], ['hold', 'HOLD'], ['slide', 'SLIDE'], ['air', 'AIR'], ['flick', 'FLICK']]) {
        if (Number(notes[key]) > 0) parts.push(`${label} ${notes[key]}`);
      }
      extras.push(`物量 ${total}${parts.length ? `（${parts.join(' / ')}）` : ''}`);
    }
    head.push(`${name} ${levelText}${extras.length ? `｜${extras.join('｜')}` : ''}`);
  }
  return head.join('\n');
}

/* ── 落雪查分 ────────────────────────────────────────────────────────── */

function toBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off', '否'].includes(s)) return false;
  if (['true', '1', 'yes', 'on', '是'].includes(s)) return true;
  return fallback;
}

async function lxnsRequest(pathname, token) {
  const body = await fetchJson(`${API_BASE}${pathname}`, {
    headers: { authorization: token },
    timeout: 25000,
    retries: 1
  });
  if (body && body.success === false) {
    const error = new Error(body.message || '落雪接口返回失败');
    error.status = Number(body.code) || 0;
    error.code = Number(body.code) || 0;
    error.body = body;
    throw error;
  }
  return body && Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body;
}

async function lookupPlayer(query, mode, token) {
  const digits = String(query ?? '').replace(/\D/g, '');
  if (!digits) throw new Error('请提供纯数字的 QQ 号或落雪好友码');

  let resolvedMode = String(mode || 'auto').toLowerCase();
  if (resolvedMode === 'auto') resolvedMode = digits.length >= 13 ? 'friend_code' : 'qq';

  const fetchFriend = async (friendCode) => {
    const player = await lxnsRequest(`/chunithm/player/${friendCode}`, token);
    return { player, friendCode: String(player?.friend_code || friendCode) };
  };

  if (resolvedMode === 'friend_code') return fetchFriend(digits);

  try {
    const player = await lxnsRequest(`/chunithm/player/qq/${digits}`, token);
    const friendCode = String(player?.friend_code || '');
    if (!friendCode) throw new Error('落雪没有返回好友码');
    return { player, friendCode };
  } catch (error) {
    // auto 模式下 QQ 查不到时，允许把入参当好友码再试一次（纯数字很容易混淆）
    if (String(mode || 'auto').toLowerCase() === 'auto' && error?.status === 404 && digits.length >= 5) {
      return fetchFriend(digits);
    }
    throw error;
  }
}

function scoreLine(s, index) {
  const level = String(s?.level ?? '').trim() || DIFF_NAMES[Number(s?.level_index)] || '';
  const rank = RANK_NAMES[String(s?.rank ?? '').toLowerCase()] || s?.rank || '';
  const clear = CLEAR_NAMES[String(s?.clear ?? '').toLowerCase()] || s?.clear || '';
  const fc = FC_NAMES[String(s?.full_combo ?? '').toLowerCase()] || '';
  const chain = CHAIN_NAMES[String(s?.full_chain ?? '').toLowerCase()] || '';
  const rating = Number(s?.rating);
  const score = Number(s?.score);
  const bits = [
    String(index + 1),
    `${s?.song_name || `#${s?.id}`}${level ? ` [${level}]` : ''}`,
    Number.isFinite(score) ? score.toLocaleString('en-US') : '分数未知',
    rank,
    clear && clear !== rank ? clear : '',
    fc,
    chain,
    Number.isFinite(rating) ? `r${rating.toFixed(2)}` : ''
  ].filter(Boolean);
  return bits.join(' · ');
}

function scoreSection(title, list, limit) {
  const rows = (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => Number(b?.rating ?? 0) - Number(a?.rating ?? 0))
    .slice(0, limit);
  if (!rows.length) return `【${title}】\n（无）`;
  return [`【${title}】（最多 ${limit} 条）`, ...rows.map(scoreLine)].join('\n');
}

function formatPlayer(player, friendCode, bests, topCount) {
  const lines = ['【落雪 LXNS｜玩家资料】'];
  lines.push(`名字：${player?.name || '（未设置）'}`);
  const rating = Number(player?.rating);
  if (Number.isFinite(rating)) lines.push(`Rating：${rating.toFixed(2)}`);
  if (player?.level != null) lines.push(`等级：${player.level}${player?.reborn_count ? `（突破 ${player.reborn_count}）` : ''}`);
  if (friendCode) lines.push(`好友码：${friendCode}`);
  if (Number.isFinite(Number(player?.over_power))) lines.push(`OVER POWER：${Number(player.over_power).toFixed(2)}`);
  if (player?.total_play_count != null) lines.push(`总游玩次数：${player.total_play_count}`);
  if (player?.upload_time) {
    const syncedAt = Date.parse(String(player.upload_time));
    lines.push(`数据同步：${Number.isFinite(syncedAt) ? `${fmtBeijing(syncedAt)}（北京时间）` : player.upload_time}`);
  }

  if (bests && !Array.isArray(bests)) {
    lines.push('');
    lines.push(scoreSection('Best 30（评分对象曲·最高）', bests.bests, topCount));
    lines.push('');
    lines.push(scoreSection('Selection 10（候选评分对象曲）', bests.selections, Math.min(topCount, 10)));
    lines.push('');
    lines.push(scoreSection('New 20（当前版本新曲）', bests.new_bests, Math.min(topCount, 20)));
  } else if (Array.isArray(bests) && bests.length) {
    lines.push('');
    lines.push(scoreSection('单曲成绩', bests, topCount));
  }

  lines.push('');
  lines.push('（数据来自落雪 LXNS，非官方；成绩需要玩家在落雪设置里允许第三方读取。）');
  return lines.join('\n');
}

function explainLxnsError(error) {
  const status = Number(error?.status);
  const msg = String(error?.message ?? error ?? '').trim();
  if (status === 401 || /unauthorized/i.test(msg)) {
    return '落雪开发者密钥无效或已过期。请到 https://maimai.lxns.net/developer 重新复制密钥，填到 QQ Agent「技能 → 中二节奏情报站 → 落雪开发者密钥」。';
  }
  if (status === 403 || /allow third party|permission|forbidden/i.test(msg)) {
    return '落雪返回 403：权限不足。请让被查的玩家登录落雪，在「账号设置 → 隐私设置」里打开「允许读取玩家信息」和「允许读取谱面成绩」，再同步一次成绩。';
  }
  if (status === 404) {
    return '落雪里找不到这个 QQ / 好友码。请确认：① QQ 已绑定落雪账号；② 好友码没有输错；③ 对方至少同步过一次成绩。';
  }
  if (status === 429) {
    return '落雪接口限流了（每秒最多 5 次），等几秒再查一次。';
  }
  return `落雪接口返回：${msg || '未知错误'}`;
}

const NO_TOKEN_HELP = [
  '这个技能用落雪（LXNS）查分，需要先配置开发者 API 密钥。',
  '1. 登录 https://maimai.lxns.net/developer/apply 申请开发者权限，拿到密钥。',
  '2. 打开 QQ Agent「技能 → 中二节奏情报站」，把密钥填到「落雪开发者密钥」并保存。',
  '3. 让被查的人在落雪「账号设置 → 隐私设置」打开「允许读取玩家信息 / 允许读取谱面成绩」。',
  '没有密钥时，官方情报和曲目/定数查询仍然可以正常用。'
].join('\n');

/* ── 技能入口 ────────────────────────────────────────────────────────── */

export function setup(api) {
  apiRef = api;
  log = (...args) => { try { api.log(...args); } catch { /* 日志失败不影响查询 */ } };

  api.registerTool({
    id: 'news',
    name: '查中二节奏官方最新情报',
    description: '获取 CHUNITHM 官方 X（@chunithm）与官方网站的最新公告、活动、更新，返回日文原文和链接。'
      + '只查资料，不发消息；拿到结果后请用中文概括，并保留原文链接。',
    category: 'knowledge',
    icon: '📰',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['all', 'x', 'official'],
          description: 'all=两边都查（默认）；x=只查官方 X；official=只查官方网站。'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: '最多返回几条，默认 10。'
        }
      }
    },
    async execute(_ctx, args) {
      try {
        const result = await getNews(String(args?.source || 'all'), Number(args?.limit) || 10);
        log(`[${SKILL_ID}] 官方情报 ${result.items.length} 条${result.warnings.length ? `（${result.warnings.join('；')}）` : ''}`);
        return { content: formatNews(result) };
      } catch (error) {
        return { content: `查官方情报失败：${shortErr(error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'song',
    name: '查中二节奏曲目与定数',
    description: '按曲名、常见别名或曲目 ID 搜索落雪 LXNS 曲目库，返回 BPM、分类、版本、各难度定数、谱师和物量。'
      + '只查资料，不发消息。查不到时不要编造，先让用户确认曲名或换别名。',
    category: 'knowledge',
    icon: '🎵',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '曲名（中日文均可）、常见别名，或纯数字曲目 ID。'
        },
        difficulty: {
          type: 'string',
          description: "只看某个难度：BASIC / ADVANCED / EXPERT / MASTER / ULTIMA / WORLD'S END，或 0~5。不填则列出全部难度。"
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: '最多返回几首匹配曲目，默认 5。'
        }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '要查哪首歌？请给我曲名、别名或曲目 ID。', isError: true };
      try {
        const data = await getSongData();
        const diff = parseDifficulty(args?.difficulty);
        const hits = searchSongs(data, query, Number(args?.limit) || 5);
        if (!hits.length) {
          return {
            content: `没有在落雪曲目库里找到「${query}」。可以试试：官方曲名、常见中文别名、或纯数字曲目 ID。\n`
              + `（当前曲库 ${data.songs.length} 首，版本 ${(data.versions || []).slice(-1)[0]?.title || '未知'}）`,
            isError: true
          };
        }
        const text = hits.map((h) => formatSong(h, data, diff)).join('\n\n———\n\n');
        log(`[${SKILL_ID}] 曲目查询「${query}」命中 ${hits.length} 首`);
        return {
          content: text + (hits.length > 1 ? '\n\n（匹配到多首，先确认是哪一首再展开说。）' : '')
        };
      } catch (error) {
        return { content: `查曲目失败：${shortErr(error)}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'player',
    name: '查落雪中二节奏成绩',
    description: '按 QQ 号或好友码查询落雪 LXNS 玩家的资料、Rating、Best 30、Selection 10、New 20。'
      + '需要在本技能设置里填写落雪开发者密钥；不填时返回申请指引。只查资料，不发消息。',
    category: 'knowledge',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '被查玩家的 QQ 号或落雪好友码（纯数字）。'
        },
        mode: {
          type: 'string',
          enum: ['auto', 'qq', 'friend_code'],
          description: 'auto=按长度自动判断（默认，13 位以上当好友码）；qq=按 QQ 号查；friend_code=按好友码查。'
        },
        scores: {
          type: 'boolean',
          description: '是否返回 Best 30 / Selection 10 / New 20，默认 true。只想看 Rating 时传 false。'
        }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      const cfg = settings();
      const token = String(cfg.lxnsToken ?? '').trim();
      if (!token) return { content: NO_TOKEN_HELP, isError: true };

      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '要查谁的？请给我 QQ 号或落雪好友码。', isError: true };

      try {
        const { player, friendCode } = await lookupPlayer(query, args?.mode, token);
        const wantScores = toBool(args?.scores, true);
        let bests = null;
        if (wantScores) {
          bests = await lxnsRequest(`/chunithm/player/${friendCode}/bests`, token);
        }
        const topCount = Math.max(1, Math.min(30, Number(cfg.playerTopCount) || 10));
        log(`[${SKILL_ID}] 查分 ${query} → ${player?.name || '?'}（r${fmtNumber(player?.rating, 2) || '?'}）`);
        return { content: formatPlayer(player, friendCode, bests, topCount) };
      } catch (error) {
        log(`[${SKILL_ID}] 查分失败 ${query}：${shortErr(error)}`);
        return { content: explainLxnsError(error), isError: true };
      }
    }
  });

  log(`[${SKILL_ID}] 中二节奏情报站已就绪（工具：${SKILL_ID}__news / ${SKILL_ID}__song / ${SKILL_ID}__player）`);
}

export function available() {
  return true;
}

export function dispose() {
  apiRef = null;
  log = () => {};
  newsCache.x = [];
  newsCache.site = [];
  newsCache.xAt = 0;
  newsCache.siteAt = 0;
  songCache = null;
}

export const internals = {
  SKILL_ID,
  DIFF_NAMES,
  RANK_NAMES,
  parseSiteDate,
  fmtBeijing,
  normalizeSearch,
  parseDifficulty,
  searchSongs,
  formatSong,
  mergeWorldsEnd,
  scoreLine,
  formatPlayer,
  explainLxnsError,
  cleanXText,
  fetchJson,
  fetchSiteNews,
  fetchXNews,
  getNews,
  getSongData,
  lookupPlayer,
  lxnsRequest,
  settings
};
