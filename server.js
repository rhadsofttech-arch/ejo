// Ejo server: serves the game, the admin dashboard and a small player API.
//
//   POST /api/signup   {pid,key,name,username,email?}      create or update a player
//   POST /api/ping     {pid,key,state,level}               "I'm online" heartbeat
//   POST /api/event    {pid,key,type,...}                  run_start, run_end, purchase
//   GET  /api/scores?board=endless|daily|l0..l8|all&date=  top scores
//   POST /api/scores   {pid,key,nick,area,endless,...}     a player's best scores
//   GET  /admin                                            dashboard (needs ADMIN_PASSWORD)
//   GET  /api/admin/stats, /api/admin/players.csv          dashboard data (Bearer ADMIN_PASSWORD)
//
// Settings (environment variables):
//   PORT                 port to listen on (default 3000)
//   DATA_DIR             where data files live (default ./data). Use a persistent volume in production.
//   ADMIN_PASSWORD       password for /admin. The dashboard stays locked until you set it.
//   PAYSTACK_SECRET_KEY  lets the server confirm payments with Paystack, so revenue counts as verified.
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = fs.existsSync(path.join(__dirname, 'dist', 'index.html')) ? path.join(__dirname, 'dist') : __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const LEVELS = 9, MAX_SCORE = 10_000_000, MAX_PLAYERS = 50000, MAX_EVENTS = 200000;
const ONLINE_MS = 90 * 1000;

// ---------- storage: plain JSON files, written a second after the last change ----------
const FILES = { players: 'scores.json', events: 'events.json' };
function load(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, FILES[name]), 'utf8')); } catch (e) { return fallback; } }
let players = load('players', {});
let events = load('events', []);
const timers = {};
function persist(name) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const f = path.join(DATA_DIR, FILES[name]);
      fs.writeFileSync(f + '.tmp', JSON.stringify(name === 'players' ? players : events));
      fs.renameSync(f + '.tmp', f);
    } catch (e) { console.error('Could not save ' + name + ':', e.message); }
  }, 1000);
}

// ---------- helpers ----------
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = v => { v = Math.floor(Number(v) || 0); return Math.max(0, Math.min(MAX_SCORE, v)); };
const clean = (s, n) => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, n);
const cleanName = s => String(s || '').replace(/[<>"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')) && String(s).length <= 80;
// days are counted in Lagos time (UTC+1, no daylight saving)
const LAGOS = 3600 * 1000;
const dayOf = t => new Date(t + LAGOS).toISOString().slice(0, 10);
const hourOf = t => new Date(t + LAGOS).getUTCHours();

const hits = new Map();
function limited(ip, bucket, max) {
  const k = bucket + ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(k, h); return h.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (!h.some(t => now - t < 60000)) hits.delete(k); }, 300000).unref();

function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-cache'
  }, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readJson(req, res, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
  req.on('end', () => { let d; try { d = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, { error: 'Bad JSON' }); } cb(d); });
}
// a player proves who they are with the secret key their device made when they signed up
function owner(d) {
  const pid = clean(d.pid, 32), key = String(d.key || '');
  if (!pid || key.length < 12) return { error: [400, 'pid and key are required'] };
  const p = players[pid];
  if (p && p.keyHash !== hash(key)) return { error: [403, 'This player id belongs to someone else'] };
  return { pid, key, p };
}
const usernameTaken = (u, pid) => Object.entries(players).some(([id, p]) => id !== pid && (p.nick || '').toLowerCase() === u.toLowerCase());
function addEvent(e) {
  events.push(e);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  persist('events');
}

// ---------- Paystack: confirm a payment really happened, and for how much ----------
function verifyPaystack(ref) {
  return new Promise(resolve => {
    if (!PAYSTACK_SECRET || !ref) return resolve(null);
    const req = https.request({ host: 'api.paystack.co', path: '/transaction/verify/' + encodeURIComponent(ref), method: 'GET',
      headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET }, timeout: 10000 }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { try { const j = JSON.parse(b); const ok = j.status && j.data && j.data.status === 'success'; resolve(ok ? { amount: j.data.amount / 100, currency: j.data.currency } : { failed: true }); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
  });
}

// ---------- scores ----------
function publicRow(id, p) {
  const row = { id, nick: p.nick, area: p.area, endless: p.endless, endlessTime: p.endlessTime, daily: p.daily, dailyDate: p.dailyDate };
  for (let i = 0; i < LEVELS; i++) row['l' + i] = p['l' + i] || 0;
  return row;
}
function top(board, date) {
  if (board !== 'endless' && board !== 'daily' && board !== 'all' && !/^l\d$/.test(board)) return [];
  let rows = Object.entries(players).filter(([, p]) => p.nick).map(([id, p]) => publicRow(id, p));
  if (board === 'all') return rows.slice(0, 1000);
  if (board === 'daily') rows = rows.filter(r => r.dailyDate === date);
  return rows.filter(r => (r[board] || 0) > 0).sort((a, b) => b[board] - a[board]).slice(0, 50);
}

// ---------- admin analytics ----------
function stats() {
  const now = Date.now(), today = dayOf(now), list = Object.entries(players).map(([id, p]) => Object.assign({ id }, p));
  const days = []; for (let i = 29; i >= 0; i--) days.push(dayOf(now - i * 86400000));
  const per = {}; days.forEach(d => per[d] = { signups: 0, active: new Set(), runs: 0, revenue: 0, purchases: 0 });
  list.forEach(p => { const d = p.created && dayOf(p.created); if (per[d]) per[d].signups++; });

  const lv = Array.from({ length: LEVELS }, () => ({ starts: 0, ends: 0, clears: 0, score: 0, secs: 0, reasons: {} }));
  const modes = {}, snakes = {}, items = {}, hours = Array(24).fill(0), reasons = {};
  let runs = 0, runSecs = 0, runsToday = 0, revV = 0, revU = 0, revToday = 0, demo = 0, purchases = 0;
  const payers = new Set(), recentBuys = [];
  for (const e of events) {
    const d = dayOf(e.t), bucket = per[d];
    if (bucket) bucket.active.add(e.pid);
    if (e.type === 'run_start') {
      runs++; if (d === today) runsToday++; if (bucket) bucket.runs++; hours[hourOf(e.t)]++;
      modes[e.mode] = (modes[e.mode] || 0) + 1; snakes[e.snake] = (snakes[e.snake] || 0) + 1;
      if (e.mode === 'levels' && lv[e.li]) lv[e.li].starts++;
    } else if (e.type === 'run_end') {
      runSecs += e.secs || 0;
      if (e.mode === 'levels' && lv[e.li]) { const L = lv[e.li]; L.ends++; if (e.won) L.clears++; L.score += e.score || 0; L.secs += e.secs || 0; if (!e.won && e.reason) L.reasons[e.reason] = (L.reasons[e.reason] || 0) + 1; }
      if (!e.won && e.reason) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
    } else if (e.type === 'purchase') {
      if (e.demo) { demo++; } else {
        purchases++; payers.add(e.pid);
        const amt = e.verified ? e.amount : 0;
        if (e.verified) revV += amt; else revU += e.price || 0;
        if (e.verified) { if (d === today) revToday += amt; if (bucket) { bucket.revenue += amt; bucket.purchases++; } }
        const it = items[e.item] || (items[e.item] = { count: 0, revenue: 0 }); it.count++; it.revenue += e.verified ? amt : (e.price || 0);
      }
      recentBuys.push(e);
    }
  }
  const ended = events.filter(e => e.type === 'run_end').length;
  const online = list.filter(p => p.lastSeen && now - p.lastSeen < ONLINE_MS).sort((a, b) => b.lastSeen - a.lastSeen);
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const areas = {}; list.forEach(p => { if (p.name) areas[p.area || 'Other'] = (areas[p.area || 'Other'] || 0) + 1; });
  const signed = list.filter(p => p.name);
  return {
    generated: now, paystackVerify: !!PAYSTACK_SECRET,
    totals: {
      users: signed.length,
      signupsToday: signed.filter(p => dayOf(p.created) === today).length,
      signups7d: signed.filter(p => now - p.created < 7 * 86400000).length,
      online: online.length, playing: online.filter(p => p.state === 'play').length,
      activeToday: list.filter(p => p.lastSeen && dayOf(p.lastSeen) === today).length,
      active7d: list.filter(p => p.lastSeen && now - p.lastSeen < 7 * 86400000).length,
      withEmail: signed.filter(p => p.email).length,
      runs, runsToday, avgRunSecs: ended ? Math.round(runSecs / ended) : 0,
      revenueVerified: revV, revenueUnverified: revU, revenueToday: revToday, purchases, demoPurchases: demo,
      payers: payers.size, arppu: payers.size ? Math.round((revV + revU) / payers.size) : 0
    },
    daily: days.map(d => ({ day: d, signups: per[d].signups, active: per[d].active.size, runs: per[d].runs, revenue: per[d].revenue })),
    hours,
    levels: lv.map((L, i) => ({ li: i, starts: L.starts, ends: L.ends, clears: L.clears, clearRate: L.ends ? L.clears / L.ends : 0, avgScore: L.ends ? Math.round(L.score / L.ends) : 0, topDeath: top(L.reasons, 1)[0] || null })),
    modes: top(modes, 10), snakes: top(snakes, 10), deaths: top(reasons, 8), areas: top(areas, 14),
    items: Object.entries(items).map(([k, v]) => ({ item: k, count: v.count, revenue: v.revenue })).sort((a, b) => b.revenue - a.revenue),
    online: online.slice(0, 100).map(p => ({ name: p.name, username: p.nick, area: p.area, state: p.state, level: p.level, since: p.sessionStart, lastSeen: p.lastSeen })),
    recentSignups: signed.sort((a, b) => b.created - a.created).slice(0, 25).map(p => ({ name: p.name, username: p.nick, email: p.email || '', area: p.area, created: p.created, best: p.endless || 0 })),
    recentPurchases: recentBuys.slice(-25).reverse().map(e => ({ t: e.t, username: (players[e.pid] || {}).nick || '?', item: e.item, price: e.price, amount: e.amount, verified: !!e.verified, demo: !!e.demo, ref: e.ref || '' })),
    topPlayers: signed.slice().sort((a, b) => (b.endless || 0) - (a.endless || 0)).slice(0, 10).map(p => ({ username: p.nick, name: p.name, area: p.area, endless: p.endless || 0, runs: p.runs || 0, spent: p.spent || 0 }))
  };
}
function playersCsv() {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['name', 'username', 'email', 'area', 'signed_up', 'last_seen', 'runs', 'best_endless', 'spent_naira'].join(',')];
  Object.values(players).filter(p => p.name).sort((a, b) => a.created - b.created).forEach(p => rows.push([p.name, p.nick, p.email, p.area,
    p.created ? new Date(p.created).toISOString() : '', p.lastSeen ? new Date(p.lastSeen).toISOString() : '', p.runs || 0, p.endless || 0, p.spent || 0].map(q).join(',')));
  return rows.join('\n');
}
function isAdmin(req, url) {
  if (!ADMIN_PASSWORD) return false;
  const given = String((req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '');
  const a = Buffer.from(hash(given)), b = Buffer.from(hash(ADMIN_PASSWORD));
  return crypto.timingSafeEqual(a, b);
}

// ---------- routes ----------
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

  if (url.pathname === '/api/signup' && req.method === 'POST') {
    if (limited(ip, 'signup', 10)) return send(res, 429, { error: 'Too many sign-ups from here. Try again in a minute.' });
    return readJson(req, res, d => {
      const o = owner(d); if (o.error) return send(res, o.error[0], { error: o.error[1] });
      const name = cleanName(d.name), username = clean(d.username, 14).replace(/\s/g, '_'), email = String(d.email || '').trim().toLowerCase();
      if (name.length < 2) return send(res, 400, { error: 'Please enter your name.' });
      if (!/^[A-Za-z0-9_-]{3,14}$/.test(username)) return send(res, 400, { error: 'Usernames are 3 to 14 letters, numbers or underscores.' });
      if (email && !isEmail(email)) return send(res, 400, { error: 'That email address does not look right.' });
      if (usernameTaken(username, o.pid)) return send(res, 409, { error: 'That username is taken. Try another one.' });
      if (!o.p && Object.keys(players).length >= MAX_PLAYERS) return send(res, 507, { error: 'Sign-ups are full right now.' });
      const now = Date.now(), p = o.p || { keyHash: hash(o.key), created: now };
      if (!p.created) p.created = now;
      p.name = name; p.nick = username; p.email = email; p.area = clean(d.area, 20) || p.area || 'Other';
      p.lastSeen = now; if (!p.sessionStart) p.sessionStart = now;
      const isNew = !o.p || !o.p.name;
      players[o.pid] = p; persist('players');
      if (isNew) addEvent({ t: now, pid: o.pid, type: 'signup' });
      return send(res, 200, { ok: true });
    });
  }

  if (url.pathname === '/api/ping' && req.method === 'POST') {
    if (limited(ip, 'ping', 30)) return send(res, 429, { error: 'Slow down' });
    return readJson(req, res, d => {
      const o = owner(d); if (o.error) return send(res, o.error[0], { error: o.error[1] });
      if (!o.p) return send(res, 404, { error: 'Sign up first' });
      const now = Date.now(), p = o.p;
      if (!p.lastSeen || now - p.lastSeen > ONLINE_MS) p.sessionStart = now;
      p.lastSeen = now; p.state = d.state === 'play' ? 'play' : 'menu'; p.level = clean(d.level, 40);
      persist('players');
      return send(res, 200, { ok: true });
    });
  }

  if (url.pathname === '/api/event' && req.method === 'POST') {
    if (limited(ip, 'event', 60)) return send(res, 429, { error: 'Slow down' });
    return readJson(req, res, async d => {
      const o = owner(d); if (o.error) return send(res, o.error[0], { error: o.error[1] });
      if (!o.p) return send(res, 404, { error: 'Sign up first' });
      const now = Date.now(), p = o.p, type = String(d.type || '');
      p.lastSeen = now;
      if (type === 'run_start') {
        p.runs = (p.runs || 0) + 1;
        addEvent({ t: now, pid: o.pid, type, mode: clean(d.mode, 12), li: Math.floor(Number(d.li)), snake: clean(d.snake, 16) });
      } else if (type === 'run_end') {
        addEvent({ t: now, pid: o.pid, type, mode: clean(d.mode, 12), li: Math.floor(Number(d.li)), snake: clean(d.snake, 16), score: num(d.score),
          eaten: num(d.eaten), secs: Math.min(36000, num(d.secs)), won: !!d.won, reason: String(d.reason || '').replace(/[<>]/g, '').slice(0, 80) });
      } else if (type === 'purchase') {
        const ref = String(d.ref || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80), price = num(d.price), demoBuy = !!d.demo || !ref;
        if (ref && events.some(e => e.type === 'purchase' && e.ref === ref)) return send(res, 200, { ok: true, duplicate: true });
        const e = { t: now, pid: o.pid, type, item: clean(d.item, 24), price, ref, demo: demoBuy };
        if (!demoBuy) {
          const v = await verifyPaystack(ref);
          if (v && v.amount) { e.verified = true; e.amount = v.amount; p.spent = (p.spent || 0) + v.amount; }
          else if (v && v.failed) e.failed = true;
        }
        if (!e.failed) addEvent(e);
      } else return send(res, 400, { error: 'Unknown event' });
      persist('players');
      return send(res, 200, { ok: true });
    });
  }

  // the game's Paystack checkout can ask the server to confirm a payment before unlocking the item
  if (url.pathname === '/api/paystack/verify' && req.method === 'GET') {
    if (!PAYSTACK_SECRET) return send(res, 501, { ok: false, error: 'Payment checks are not set up on this server' });
    return verifyPaystack(String(url.searchParams.get('reference') || '')).then(v => send(res, 200, { ok: !!(v && v.amount), amount: v && v.amount }));
  }

  if (url.pathname === '/api/scores' && req.method === 'GET') {
    const board = String(url.searchParams.get('board') || 'endless');
    const date = isDate(url.searchParams.get('date')) ? url.searchParams.get('date') : dayOf(Date.now());
    return send(res, 200, { rows: top(board, date) });
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    if (limited(ip, 'scores', 20)) return send(res, 429, { error: 'Too many score updates. Try again in a minute.' });
    return readJson(req, res, d => {
      const o = owner(d); if (o.error) return send(res, o.error[0], { error: o.error[1] });
      const nick = clean(d.nick, 14);
      if (!nick) return send(res, 400, { error: 'nick is required' });
      if (!o.p && Object.keys(players).length >= MAX_PLAYERS) return send(res, 507, { error: 'Score store is full' });
      const p = o.p || { keyHash: hash(o.key), created: Date.now() };
      if (!p.name && !usernameTaken(nick, o.pid)) p.nick = nick; // signed-up players keep their username
      if (!p.nick) p.nick = nick;
      p.area = clean(d.area, 20) || p.area || 'Other';
      p.endless = Math.max(p.endless || 0, num(d.endless));
      if (num(d.endless) >= (p.endless || 0)) p.endlessTime = Math.max(p.endlessTime || 0, num(d.endlessTime));
      if (isDate(d.dailyDate)) {
        if (p.dailyDate !== d.dailyDate) { p.dailyDate = d.dailyDate; p.daily = num(d.daily); }
        else p.daily = Math.max(p.daily || 0, num(d.daily));
      }
      for (let i = 0; i < LEVELS; i++) p['l' + i] = Math.max(p['l' + i] || 0, num(d['l' + i]));
      p.updated = Date.now();
      players[o.pid] = p; persist('players');
      return send(res, 200, { ok: true });
    });
  }

  if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
    if (!ADMIN_PASSWORD) return send(res, 503, { error: 'The admin dashboard is locked. Set ADMIN_PASSWORD on the server to open it.' });
    if (limited(ip, 'admin', 60)) return send(res, 429, { error: 'Slow down' });
    if (!isAdmin(req, url)) return send(res, 401, { error: 'Wrong password' });
    return send(res, 200, stats());
  }
  if (url.pathname === '/api/admin/players.csv' && req.method === 'GET') {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'Wrong password' });
    return send(res, 200, playersCsv(), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="ejo-players.csv"' });
  }
  // images, icons and the app manifest (the link-preview thumbnail lives here)
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const dir = path.join(ROOT, 'assets'), file = path.join(ROOT, url.pathname);
    const type = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' }[path.extname(file).toLowerCase()];
    if (!file.startsWith(dir + path.sep) || !type || !fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), type, { 'Cache-Control': 'public, max-age=86400' });
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    const f = path.join(ROOT, 'assets', 'favicon-32.png');
    if (fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), 'image/png', { 'Cache-Control': 'public, max-age=86400' });
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'admin.html')), 'text/html; charset=utf-8', { 'X-Robots-Tag': 'noindex' });
  }

  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
  return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
}).listen(PORT, () => console.log('Ejo is running on port ' + PORT + (ADMIN_PASSWORD ? '' : ' (admin locked: set ADMIN_PASSWORD)')));
