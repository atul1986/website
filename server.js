/*
 * atul-sir.onrender.com — website server
 * - Serves the site from /public
 * - Records every visit (approx. location, device, browser, page, referrer, time on page)
 * - Powers the chatbot (uses Claude if ANTHROPIC_API_KEY is set; otherwise the page's built-in assistant answers)
 * - Private admin dashboard at /admin (protected by ADMIN_KEY)
 *
 * Environment variables (set them in Render → your service → Environment):
 *   ADMIN_KEY          required for /admin — any long secret you choose
 *   MONGODB_URI        recommended — free MongoDB Atlas connection string (keeps data forever)
 *                      without it, data is saved to data/*.json, which Render's free plan wipes on every redeploy
 *   ANTHROPIC_API_KEY  optional — makes the chatbot answer freely using Claude
 *   CHAT_MODEL         optional — defaults to claude-haiku-5-5
 *   SERPAPI_KEY        optional — exact Google Scholar numbers, refreshed daily (free key at serpapi.com).
 *                      without it, figures refresh daily from OpenAlex (free, open data)
 *   OPENALEX_KEY       recommended with OpenAlex — free key from openalex.org/settings/api
 *   NAME_VARIANTS      optional — comma-separated name spellings to search on Google (defaults cover Atul Kathole, Dr. Atul B. Kathole, Atul Baliram Kathole…)
 *   GOOGLE_API_KEY     optional — Google Books API key for higher daily limits
 *   IP_SALT            optional — any random text; used to count unique visitors without storing full IPs
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const IP_SALT = process.env.IP_SALT || 'atul-sir-default-salt';
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-haiku-5-5';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.text({ limit: '5kb', type: 'text/plain' }));

/* ---------------------------------------------------------------- storage */
function makeFileStore() {
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = n => path.join(dir, n + '.json');
  const load = n => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return []; } };
  const cols = { visits: load('visits'), chats: load('chats') };
  const timers = {};
  const save = n => { clearTimeout(timers[n]); timers[n] = setTimeout(() => fs.writeFile(file(n), JSON.stringify(cols[n].slice(-50000)), () => {}), 800); };
  const flush = () => { for (const n in cols) { try { fs.writeFileSync(file(n), JSON.stringify(cols[n].slice(-50000))); } catch {} } };
  ['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => { flush(); process.exit(0); }));
  return {
    kind: 'file',
    async insert(n, doc) { cols[n].push(doc); save(n); },
    async update(n, id, patch) { const d = cols[n].find(x => x._id === id); if (d) { Object.assign(d, patch); save(n); } },
    async all(n, since) { return since ? cols[n].filter(d => d.ts >= since) : cols[n]; },
    async count(n, since) { return since ? cols[n].filter(d => d.ts >= since).length : cols[n].length; },
    async recent(n, limit) { return cols[n].slice(-limit).reverse(); },
    async distinct(n, field) { return new Set(cols[n].map(d => d[field])).size; }
  };
}

async function makeMongoStore(uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'atulsir');
  await db.collection('visits').createIndex({ ts: -1 });
  await db.collection('chats').createIndex({ ts: -1 });
  const c = n => db.collection(n);
  return {
    kind: 'mongodb',
    async insert(n, doc) { await c(n).insertOne(doc); },
    async update(n, id, patch) { await c(n).updateOne({ _id: id }, { $set: patch }); },
    async all(n, since) { return c(n).find(since ? { ts: { $gte: since } } : {}).sort({ ts: -1 }).limit(50000).toArray(); },
    async count(n, since) { return c(n).countDocuments(since ? { ts: { $gte: since } } : {}); },
    async recent(n, limit) { return c(n).find({}).sort({ ts: -1 }).limit(limit).toArray(); },
    async distinct(n, field) { return (await c(n).distinct(field)).length; }
  };
}

let store = makeFileStore();
if (process.env.MONGODB_URI) {
  makeMongoStore(process.env.MONGODB_URI)
    .then(s => { store = s; console.log('Storage: MongoDB connected'); })
    .catch(e => console.error('MongoDB connection failed, using file storage:', e.message));
} else {
  console.log('Storage: local files in data/ (set MONGODB_URI to keep data across redeploys)');
}

/* ---------------------------------------------------------------- helpers */
const id = () => crypto.randomBytes(9).toString('hex');
const clientIp = req => (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().replace(/^::ffff:/, '');
const maskIp = ip => ip.includes('.') ? ip.split('.').slice(0, 3).join('.') + '.x' : ip.split(':').slice(0, 3).join(':') + ':x';
const hashIp = ip => crypto.createHash('sha256').update(IP_SALT + ip).digest('hex').slice(0, 16);
const clip = (v, n = 200) => (v == null ? '' : String(v)).slice(0, n);
const istDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istMidnight = () => new Date(istDay() + 'T00:00:00+05:30').getTime();

function parseUA(ua = '') {
  const device = /iPad|Tablet/i.test(ua) ? 'Tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'Mobile' : 'Desktop';
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const bot = /bot|crawl|spider|slurp|preview|headless|lighthouse/i.test(ua);
  return { device, os, browser, bot };
}

const geoCache = new Map();
async function geo(ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|::1|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return { country: 'Local', region: '', city: '' };
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,regionName,city,isp`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    const g = j.status === 'success' ? { country: j.country, cc: j.countryCode, region: j.regionName, city: j.city, isp: j.isp } : { country: 'Unknown' };
    if (geoCache.size > 5000) geoCache.clear();
    geoCache.set(ip, g); return g;
  } catch { return { country: 'Unknown' }; }
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(key, arr); return arr.length > max;
}

async function publicStats() {
  const now = Date.now();
  const [total, today, unique, online] = await Promise.all([
    store.count('visits'), store.count('visits', istMidnight()), store.distinct('visits', 'vid'), store.count('visits', now - 5 * 60 * 1000)
  ]);
  return { total, today, unique, online };
}

/* ---------------------------------------------------------------- visit API */
app.post('/api/visit', async (req, res) => {
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ip = clientIp(req);
    if (limited('v' + ip, 30, 60000)) return res.status(429).json({ error: 'Too many requests' });
    const ua = clip(req.headers['user-agent'], 300);
    const u = parseUA(ua);
    const doc = {
      _id: id(), ts: Date.now(), day: istDay(),
      vid: clip(b.vid, 40) || hashIp(ip), ipHash: hashIp(ip), ip: maskIp(ip),
      page: clip(b.page, 120), ref: clip(b.ref, 200), lang: clip(b.lang, 20), tz: clip(b.tz, 40), screen: clip(b.screen, 20),
      returning: !!b.returning, ua, ...u, duration: 0
    };
    if (!u.bot) Object.assign(doc, await geo(ip));
    if (!u.bot) await store.insert('visits', doc);
    const s = await publicStats();
    res.json({ visitId: doc._id, ...s, you: s.total });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not record visit' }); }
});

app.post('/api/visit/:id/leave', async (req, res) => {
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dur = Math.max(0, Math.min(6 * 3600, Math.round(+b.duration || 0)));
    await store.update('visits', clip(req.params.id, 40), { duration: dur, scrolled: Math.max(0, Math.min(100, +b.scrolled || 0)), sections: clip(b.sections, 200) });
  } catch {}
  res.status(204).end();
});

app.get('/api/stats', async (req, res) => {
  try { res.json(await publicStats()); } catch { res.status(500).json({ error: 'Stats unavailable' }); }
});

/* ---------------------------------------------------------------- announcements */
app.get('/api/announcements', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(path.join(__dirname, 'announcements.json'), 'utf8'))); }
  catch { res.json([]); }
});

/* ---------------------------------------------------------------- chatbot API */
const PROFILE = fs.existsSync(path.join(__dirname, 'chatbot-knowledge.md')) ? fs.readFileSync(path.join(__dirname, 'chatbot-knowledge.md'), 'utf8') : '';
const SYSTEM = `You are the website assistant for Dr. Atul B. Kathole, a professor in Pune, India. You speak on his behalf in a warm, encouraging and concise way (2–5 short sentences, plain text, no markdown headers).
Answer only from the facts below. If something isn't covered, say you don't have that detail and suggest using the contact form on the page. Never invent publications, numbers, fees, phone numbers or emails.
Students often visit: be motivating and practical. Point people to sections of the page when useful (#publications, #patents, #collaborate, #book, #contact, #gallery).

FACTS:
${PROFILE}`;

app.post('/api/chat', async (req, res) => {
  const ip = clientIp(req);
  if (limited('c' + ip, 20, 60000)) return res.status(429).json({ reply: 'You are sending messages very quickly — please wait a moment.' });
  const msg = clip(req.body && req.body.message, 600).trim();
  const history = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8) : [];
  if (!msg) return res.status(400).json({ reply: null });
  let reply = null, source = 'local';
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const messages = history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.text)
        .map(m => ({ role: m.role, content: clip(m.text, 800) }));
      if (!messages.length || messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: msg });
      while (messages.length && messages[0].role !== 'user') messages.shift();
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CHAT_MODEL, max_tokens: 400, system: SYSTEM, messages })
      });
      clearTimeout(t);
      const j = await r.json();
      if (r.ok && j.content && j.content[0]) { reply = j.content.map(c => c.text || '').join('').trim(); source = 'ai'; }
      else console.error('Chat API error:', j.error && j.error.message);
    } catch (e) { console.error('Chat API failed:', e.message); }
  }
  store.insert('chats', { _id: id(), ts: Date.now(), vid: clip(req.body.vid, 40), q: msg, a: reply ? clip(reply, 1000) : clip(req.body.localAnswer, 300), source, ip: maskIp(ip) }).catch(() => {});
  res.json({ reply, source });
});


/* ---------------------------------------------------------------- research metrics auto-update
 * Updates once a day (and on demand from /admin).
 *  1. SERPAPI_KEY set  → exact Google Scholar figures via SerpApi's Google Scholar Author API
 *                        (Google does not allow direct scraping of Scholar; SerpApi is the licensed route, free tier 100/month)
 *  2. otherwise        → OpenAlex open API (free, no key) for citations, h-index, yearly counts and the newest papers
 * The last good result is saved in data/scholar.json, so the site never shows blanks.
 */
const SCHOLAR_ID = process.env.SCHOLAR_ID || '5kZO4MoAAAAJ';
const ORCID = process.env.ORCID || '0000-0002-6162-8200';
const OA_KEY = process.env.OPENALEX_KEY ? '&api_key=' + encodeURIComponent(process.env.OPENALEX_KEY) : '';
const scholarFile = path.join(__dirname, 'data', 'scholar.json');
let scholar = (() => { try { return JSON.parse(fs.readFileSync(scholarFile, 'utf8')); } catch { return null; } })();

async function getJSON(url, ms = 20000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'atul-sir-website (mailto:site@atul-sir.onrender.com)' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

async function fromSerpApi() {
  const base = `https://serpapi.com/search.json?engine=google_scholar_author&author_id=${SCHOLAR_ID}&hl=en&api_key=${process.env.SERPAPI_KEY}`;
  const j = await getJSON(base + '&sort=pubdate&num=100');
  const tbl = (j.cited_by && j.cited_by.table) || [];
  const pick = k => (tbl.find(r => r[k]) || {})[k] || {};
  const sinceKey = o => Object.keys(o).find(k => k.startsWith('since')) || '';
  const c = pick('citations'), h = pick('h_index'), i = pick('i10_index');
  const graph = {}; ((j.cited_by && j.cited_by.graph) || []).forEach(g => { graph[g.year] = g.citations; });
  const pubs = (j.articles || []).map(a => ({ t: a.title, v: (a.publication || '').replace(/,?\s*\d{4}$/, '').split(/\s\d/)[0].trim(), y: +a.year || 0, c: (a.cited_by && a.cited_by.value) || 0, url: a.link }));
  return { source: 'Google Scholar', citations: c.all, citationsSince: c[sinceKey(c)], hIndex: h.all, hIndexSince: h[sinceKey(h)], i10: i.all, i10Since: i[sinceKey(i)], sinceYear: (sinceKey(c).match(/\d{4}/) || [''])[0], perYear: graph, pubs };
}

async function fromOpenAlex() {
  const a = await getJSON(`https://api.openalex.org/authors/orcid:${ORCID}?mailto=site@atul-sir.onrender.com${OA_KEY}`);
  const perYear = {}; (a.counts_by_year || []).forEach(r => { perYear[r.year] = r.cited_by_count; });
  const w = await getJSON(`https://api.openalex.org/works?filter=author.orcid:${ORCID}&sort=publication_date:desc&per_page=100${OA_KEY}`);
  const pubs = (w.results || []).map(x => ({ t: x.display_name || x.title, v: (x.primary_location && x.primary_location.source && x.primary_location.source.display_name) || '', y: x.publication_year || 0, c: x.cited_by_count || 0, url: x.doi || x.id }));
  return { source: 'OpenAlex', citations: a.cited_by_count, hIndex: a.summary_stats && a.summary_stats.h_index, i10: a.summary_stats && a.summary_stats.i10_index, perYear, pubs, works: a.works_count };
}

async function refreshScholar() {
  try {
    const d = process.env.SERPAPI_KEY ? await fromSerpApi() : await fromOpenAlex();
    if (!d.citations) throw new Error('empty result');
    scholar = { ...d, updated: new Date().toISOString() };
    fs.mkdirSync(path.dirname(scholarFile), { recursive: true });
    fs.writeFileSync(scholarFile, JSON.stringify(scholar));
    console.log(`Research metrics updated from ${d.source}: ${d.citations} citations, ${d.pubs.length} papers`);
    return { ok: true, source: d.source };
  } catch (e) { console.error('Research metrics update failed:', e.message); return { ok: false, error: e.message }; }
}
setTimeout(refreshScholar, 5000);
setInterval(refreshScholar, 24 * 3600 * 1000);

app.get('/api/scholar', (req, res) => { res.set('Cache-Control', 'public, max-age=3600'); res.json(scholar || { source: null }); });


/* ---------------------------------------------------------------- Google sync (books, news, new publications)
 * Once a day the server searches for every spelling of your name and keeps the results in data/websync.json:
 *  - Google Books API  → books you edited or wrote (published and upcoming)
 *  - Google News RSS   → news articles and announcements that mention you
 *  - Crossref API      → new papers, chapters and books with a DOI
 * Names searched come from NAME_VARIANTS (comma-separated) or the defaults below.
 */
const NAMES = (process.env.NAME_VARIANTS || 'Atul Kathole,Dr. Atul Kathole,Dr. Atul B. Kathole,Atul B. Kathole,Atul Baliram Kathole,Dr. Atul Baliram Kathole')
  .split(',').map(s => s.trim()).filter(Boolean);
const SURNAME = /kathole/i;
const webFile = path.join(__dirname, 'data', 'websync.json');
let web = (() => { try { return JSON.parse(fs.readFileSync(webFile, 'utf8')); } catch { return { books: [], news: [], works: [] }; } })();
const normT = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
const bareName = n => n.replace(/^dr\.?\s*/i, '').replace(/\./g, '').trim();

async function getText(url, ms = 15000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (atul-sir website sync)' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}

async function syncGoogleBooks() {
  const found = new Map();
  const names = [...new Set(NAMES.map(bareName))];
  for (const n of names) {
    const key = process.env.GOOGLE_API_KEY ? '&key=' + process.env.GOOGLE_API_KEY : '';
    const j = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`inauthor:"${n}"`)}&maxResults=40&printType=books${key}`).catch(() => ({}));
    for (const it of j.items || []) {
      const v = it.volumeInfo || {};
      if (!(v.authors || []).some(a => SURNAME.test(a))) continue;
      const k = normT(v.title); if (!k || found.has(k)) continue;
      const isbn = (v.industryIdentifiers || []).find(x => x.type === 'ISBN_13') || {};
      found.set(k, { title: v.title, subtitle: v.subtitle || '', people: (v.authors || []).join(', '), publisher: v.publisher || '', date: v.publishedDate || '', isbn: isbn.identifier || '',
        cover: ((v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '').replace('http://', 'https://'), link: v.infoLink || v.canonicalVolumeLink || '' });
    }
  }
  return [...found.values()];
}

function parseRss(xml) {
  const tag = (s, t) => { const m = s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
  const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '');
  return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map(it => ({ title: dec(tag(it, 'title')), link: dec(tag(it, 'link')), date: tag(it, 'pubDate'), source: dec(tag(it, 'source')) }));
}
async function syncGoogleNews() {
  const found = new Map();
  for (const n of NAMES) {
    const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${n}"`)}&hl=en-IN&gl=IN&ceid=IN:en`).catch(() => '');
    for (const it of parseRss(xml)) { const k = normT(it.title); if (k && !found.has(k)) found.set(k, it); }
  }
  return [...found.values()].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);
}

async function syncCrossref() {
  const found = new Map();
  for (const n of [...new Set(NAMES.map(bareName))]) {
    const j = await getJSON(`https://api.crossref.org/works?query.author=${encodeURIComponent(n)}&sort=published&order=desc&rows=60&select=DOI,title,type,published,container-title,author,editor,publisher&mailto=site@atul-sir.onrender.com`, 25000).catch(() => ({}));
    for (const w of (j.message && j.message.items) || []) {
      const people = [...(w.author || []), ...(w.editor || [])];
      const me = people.find(p => SURNAME.test(p.family || '') && /^a/i.test(p.given || ''));
      if (!me) continue;
      const title = (w.title || [])[0]; const k = normT(title); if (!k || found.has(k)) continue;
      const y = (((w.published || {})['date-parts'] || [[0]])[0] || [0])[0];
      found.set(k, { t: title, v: (w['container-title'] || [])[0] || w.publisher || '', y, type: w.type, role: (w.editor || []).includes(me) ? 'editor' : 'author', url: 'https://doi.org/' + w.DOI });
    }
  }
  return [...found.values()].sort((a, b) => b.y - a.y);
}

async function refreshWeb() {
  const [books, news, works] = await Promise.all([syncGoogleBooks().catch(() => null), syncGoogleNews().catch(() => null), syncCrossref().catch(() => null)]);
  web = { books: books || web.books || [], news: news || web.news || [], works: works || web.works || [], names: NAMES, updated: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(webFile), { recursive: true }); fs.writeFileSync(webFile, JSON.stringify(web)); } catch {}
  console.log(`Google sync: ${web.books.length} books, ${web.news.length} news items, ${web.works.length} works`);
  return { ok: !!(books || news || works), books: web.books.length, news: web.news.length, works: web.works.length };
}
setTimeout(refreshWeb, 9000);
setInterval(refreshWeb, 24 * 3600 * 1000);
app.get('/api/web', (req, res) => { res.set('Cache-Control', 'public, max-age=3600'); res.json(web); });

/* ---------------------------------------------------------------- admin API */
function admin(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin is turned off. Set ADMIN_KEY in your server environment to turn it on.' });
  const k = req.headers['x-admin-key'] || '';
  const ok = k.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));
  if (!ok) { limited('a' + clientIp(req), 10, 60000); return res.status(401).json({ error: 'Wrong admin key' }); }
  next();
}
const tally = (rows, f, n = 10) => Object.entries(rows.reduce((m, r) => { const k = (typeof f === 'function' ? f(r) : r[f]) || 'Unknown'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, n);

app.get('/api/admin/summary', admin, async (req, res) => {
  const days = Math.min(365, +req.query.days || 30);
  const since = Date.now() - days * 864e5;
  const rows = await store.all('visits', since);
  const daily = {};
  for (let i = days - 1; i >= 0; i--) daily[istDay(new Date(Date.now() - i * 864e5))] = 0;
  rows.forEach(r => { if (r.day in daily) daily[r.day]++; });
  const durs = rows.map(r => r.duration || 0).filter(d => d > 0);
  res.json({
    storage: store.kind, ...(await publicStats()),
    period: { days, visits: rows.length, unique: new Set(rows.map(r => r.vid)).size, avgSeconds: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0 },
    daily, countries: tally(rows, 'country'), cities: tally(rows, r => r.city ? `${r.city}, ${r.cc || r.country}` : null), devices: tally(rows, 'device'),
    browsers: tally(rows, 'browser'), os: tally(rows, 'os'),
    referrers: tally(rows, r => { try { return r.ref ? new URL(r.ref).hostname : 'Direct'; } catch { return 'Direct'; } }),
    chats: await store.count('chats')
  });
});
app.post('/api/admin/refresh-scholar', admin, async (req, res) => { const [a, b] = await Promise.all([refreshScholar(), refreshWeb()]); res.json({ ...a, web: b }); });
app.get('/api/admin/visits', admin, async (req, res) => res.json(await store.recent('visits', Math.min(1000, +req.query.limit || 200))));
app.get('/api/admin/chats', admin, async (req, res) => res.json(await store.recent('chats', Math.min(1000, +req.query.limit || 200))));
app.get('/api/admin/export.csv', admin, async (req, res) => {
  const rows = await store.all('visits');
  const cols = ['ts', 'day', 'country', 'region', 'city', 'isp', 'ip', 'device', 'os', 'browser', 'page', 'ref', 'lang', 'tz', 'screen', 'returning', 'duration', 'scrolled'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(c === 'ts' ? new Date(r.ts).toISOString() : r[c])).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="visitors.csv"'); res.send(csv);
});

/* ---------------------------------------------------------------- pages */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Old page links from the previous site now jump to the matching section
const OLD = { bio: 'about', experience: 'about', 'portfolio-handled': 'leadership', contact: 'contact', patents: 'patents', copyrights: 'patents', publications: 'publications', expertsession: 'leadership', 'research-grant': 'leadership', achievements: 'gallery' };
app.get('/:old', (req, res, next) => OLD[req.params.old] ? res.redirect(301, '/#' + OLD[req.params.old]) : next());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Site running on http://localhost:${PORT}`));
