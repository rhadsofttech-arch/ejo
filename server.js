// Ejo server: serves the game and a small live-scores API.
//   GET  /api/scores?board=endless|daily|l0..l8|all&date=YYYY-MM-DD   top scores
//   POST /api/scores  {pid,key,nick,area,endless,endlessTime,daily,dailyDate,l0..l8}
// Scores are kept in DATA_DIR/scores.json (default ./data). Point DATA_DIR at a
// persistent volume in production, or scores reset when the container restarts.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = fs.existsSync(path.join(__dirname, 'dist', 'index.html')) ? path.join(__dirname, 'dist') : __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'scores.json');
const LEVELS = 9, MAX_SCORE = 10_000_000, MAX_PLAYERS = 20000;

let players = {};
try { players = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { players = {}; }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(players)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { console.error('Could not save scores:', e.message); }
  }, 1000);
}

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = v => { v = Math.floor(Number(v) || 0); return Math.max(0, Math.min(MAX_SCORE, v)); };
const clean = (s, n) => String(s || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, n);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// simple per-IP rate limit for writes
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(ip, h); return h.length > 20;
}

function publicRow(id, p) {
  const row = { id, nick: p.nick, area: p.area, endless: p.endless, endlessTime: p.endlessTime, daily: p.daily, dailyDate: p.dailyDate };
  for (let i = 0; i < LEVELS; i++) row['l' + i] = p['l' + i] || 0;
  return row;
}

function top(board, date) {
  let field = board;
  if (board === 'daily') field = 'daily';
  else if (board !== 'endless' && board !== 'all' && !/^l\d$/.test(board)) return [];
  let rows = Object.entries(players).map(([id, p]) => publicRow(id, p));
  if (board === 'all') return rows.slice(0, 1000);
  if (board === 'daily') rows = rows.filter(r => r.dailyDate === date);
  return rows.filter(r => (r[field] || 0) > 0).sort((a, b) => b[field] - a[field]).slice(0, 50);
}

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache'
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');

  if (url.pathname === '/api/scores' && req.method === 'GET') {
    const board = String(url.searchParams.get('board') || 'endless');
    const date = isDate(url.searchParams.get('date')) ? url.searchParams.get('date') : new Date().toISOString().slice(0, 10);
    return send(res, 200, { rows: top(board, date) });
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (limited(ip)) return send(res, 429, { error: 'Too many score updates. Try again in a minute.' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let d; try { d = JSON.parse(body); } catch (e) { return send(res, 400, { error: 'Bad JSON' }); }
      const pid = clean(d.pid, 32), key = String(d.key || '');
      const nick = clean(d.nick, 14);
      if (!pid || key.length < 12 || !nick) return send(res, 400, { error: 'pid, key and nick are required' });
      const existing = players[pid];
      if (existing && existing.keyHash !== hash(key)) return send(res, 403, { error: 'This player id belongs to someone else' });
      if (!existing && Object.keys(players).length >= MAX_PLAYERS) return send(res, 507, { error: 'Score store is full' });
      const p = existing || { keyHash: hash(key) };
      p.nick = nick; p.area = clean(d.area, 20) || 'Other';
      // keep each player's best, never lower it
      p.endless = Math.max(p.endless || 0, num(d.endless));
      if (num(d.endless) >= (p.endless || 0)) p.endlessTime = Math.max(p.endlessTime || 0, num(d.endlessTime));
      if (isDate(d.dailyDate)) {
        if (p.dailyDate !== d.dailyDate) { p.dailyDate = d.dailyDate; p.daily = num(d.daily); }
        else p.daily = Math.max(p.daily || 0, num(d.daily));
      }
      for (let i = 0; i < LEVELS; i++) p['l' + i] = Math.max(p['l' + i] || 0, num(d['l' + i]));
      p.updated = Date.now();
      players[pid] = p; persist();
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
  }
  if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
  return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
}).listen(PORT, () => console.log('Ejo is running on port ' + PORT));
