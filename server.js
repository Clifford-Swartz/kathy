import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SYSTEM_PROMPT } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5317;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'facilities.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 10 * 60 * 1000;

if (!BRIDGE_TOKEN) {
  console.warn('\n  ⚠  BRIDGE_TOKEN is not set — /bridge endpoints will reject all traffic.\n');
}

await fsp.mkdir(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) await fsp.writeFile(DB_PATH, '{"facilities":[]}');

async function readDB() { return JSON.parse(await fsp.readFile(DB_PATH, 'utf8')); }
async function writeDB(db) {
  const tmp = DB_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
  await fsp.rename(tmp, DB_PATH);
}

// ---------- Seed (Option A) ----------
// 20 well-known CCRCs so the map is never empty on first load. Geocoded
// lazily by the background geocoder once the server boots.
const SEED_CCRCS = [
  { name: 'Kendal at Hanover', city: 'Hanover', state: 'NH' },
  { name: 'Kendal at Oberlin', city: 'Oberlin', state: 'OH' },
  { name: 'Kendal-Crosslands Communities', city: 'Kennett Square', state: 'PA' },
  { name: 'Foulkeways at Gwynedd', city: 'Gwynedd', state: 'PA' },
  { name: 'RiverWoods Exeter', city: 'Exeter', state: 'NH' },
  { name: "Mary's Woods", city: 'Lake Oswego', state: 'OR' },
  { name: 'Riderwood', city: 'Silver Spring', state: 'MD' },
  { name: 'Charlestown', city: 'Catonsville', state: 'MD' },
  { name: 'Greenspring', city: 'Springfield', state: 'VA' },
  { name: 'Goodwin House Alexandria', city: 'Alexandria', state: 'VA' },
  { name: 'Westminster-Canterbury Richmond', city: 'Richmond', state: 'VA' },
  { name: 'Westminster-Canterbury on Chesapeake Bay', city: 'Virginia Beach', state: 'VA' },
  { name: 'Brooksby Village', city: 'Peabody', state: 'MA' },
  { name: 'Linden Ponds', city: 'Hingham', state: 'MA' },
  { name: 'Pennswood Village', city: 'Newtown', state: 'PA' },
  { name: 'Cornwall Manor', city: 'Cornwall', state: 'PA' },
  { name: 'Carlsbad By The Sea', city: 'Carlsbad', state: 'CA' },
  { name: 'Vi at La Jolla Village', city: 'La Jolla', state: 'CA' },
  { name: 'Carol Woods', city: 'Chapel Hill', state: 'NC' },
  { name: 'Givens Estates', city: 'Asheville', state: 'NC' },
];

async function seedIfEmpty() {
  const db = await readDB();
  if (db.facilities.length > 0) return;
  for (const seed of SEED_CCRCS) {
    db.facilities.push({
      id: randomUUID(),
      name: seed.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      analysis: null,
      notes: '',
      source: 'seed',
      city: seed.city,
      state: seed.state,
      lat: null,
      lon: null,
    });
  }
  await writeDB(db);
  console.log(`[seed] inserted ${SEED_CCRCS.length} seed facilities`);
}
await seedIfEmpty();

// ---------- Geocoder worker ----------
// Walks the DB looking for facilities with a location but no lat/lon, hits
// Nominatim (free OpenStreetMap geocoder) at 1 req/sec, saves results.
async function geocodeOnce(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'kathy-ccrc-analyzer (research tool, https://github.com/Clifford-Swartz/kathy)',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  } catch (err) {
    console.error('[geocoder] fetch failed:', err.message);
    return null;
  }
}

function geocodeQueryFor(fac) {
  // Prefer the explicit city/state, fall back to analysis identity.location
  if (fac.city && fac.state) return `${fac.name}, ${fac.city}, ${fac.state}`;
  const loc = fac.analysis?.identity?.location;
  if (loc) return `${fac.name}, ${loc}`;
  return null;
}

async function runGeocoderLoop() {
  // ~1 req/sec = polite to Nominatim's free tier.
  while (true) {
    try {
      const db = await readDB();
      const target = db.facilities.find((f) => f.lat == null && !f.geocodeFailed && geocodeQueryFor(f));
      if (!target) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      const q = geocodeQueryFor(target);
      const result = await geocodeOnce(q);
      const db2 = await readDB();
      const fac = db2.facilities.find((f) => f.id === target.id);
      if (fac) {
        if (result) {
          fac.lat = result.lat;
          fac.lon = result.lon;
          console.log(`[geocoder] ${q} → ${result.lat.toFixed(3)}, ${result.lon.toFixed(3)}`);
        } else {
          fac.geocodeFailed = true;
          console.log(`[geocoder] ${q} → no result`);
        }
        await writeDB(db2);
      }
    } catch (err) {
      console.error('[geocoder] loop error:', err.message);
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
}
runGeocoderLoop();


// ---------- Bridge (desktop) SSE ----------

let bridge = null;
const pendingJobs = new Map();

// Per-facility browser SSE subscriber sets
const browserSubs = new Map(); // facilityId -> Set<res>
// Map jobId -> facilityId -> assistantMessageId (so bridge deltas know where to go)
const jobRouting = new Map();

function browserFanout(facilityId, event, data) {
  const subs = browserSubs.get(facilityId);
  if (!subs) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try { res.write(line); } catch {}
  }
}

function dispatchJob(job) {
  if (!bridge) return false;
  try {
    if (job.kind === 'discover') {
      bridge.res.write(`event: discover\ndata: ${JSON.stringify({
        jobId: job.jobId,
        prompt: job.prompt,
      })}\n\n`);
    } else {
      bridge.res.write(`event: analyze\ndata: ${JSON.stringify({
        jobId: job.jobId,
        systemPrompt: SYSTEM_PROMPT,
        messages: job.messages,
      })}\n\n`);
    }
    job.dispatched = true;
    return true;
  } catch {
    return false;
  }
}

function enqueueJob(messages, facilityId, assistantMessageId) {
  return new Promise((resolve, reject) => {
    const jobId = randomUUID();
    const job = { jobId, kind: 'analyze', messages, facilityId, assistantMessageId, resolve, reject, dispatched: false };
    job.timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      jobRouting.delete(jobId);
      reject(new Error('Job timed out waiting for bridge'));
    }, JOB_TIMEOUT_MS);
    pendingJobs.set(jobId, job);
    jobRouting.set(jobId, { facilityId, assistantMessageId });
    if (bridge) dispatchJob(job);
  });
}

function enqueueDiscoverJob(prompt) {
  return new Promise((resolve, reject) => {
    const jobId = randomUUID();
    const job = { jobId, kind: 'discover', prompt, resolve, reject, dispatched: false };
    job.timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      reject(new Error('Discover job timed out'));
    }, JOB_TIMEOUT_MS);
    pendingJobs.set(jobId, job);
    if (bridge) dispatchJob(job);
  });
}

function flushQueueToBridge() {
  for (const job of pendingJobs.values()) if (!job.dispatched) dispatchJob(job);
}

function finishJob(jobId, ok, payload) {
  const job = pendingJobs.get(jobId);
  if (!job) return;
  clearTimeout(job.timer);
  pendingJobs.delete(jobId);
  jobRouting.delete(jobId);
  if (ok) job.resolve(payload);
  else job.reject(new Error(payload || 'bridge error'));
}

// ---------- Dashboard parser ----------

function parseDashboard(fullText) {
  // Pull the LAST <dashboard>...</dashboard> block from the assistant's text.
  const re = /<dashboard>\s*([\s\S]*?)\s*<\/dashboard>/gi;
  let match, last = null;
  while ((match = re.exec(fullText)) !== null) last = match[1];
  if (!last) return { dashboard: null, chatText: fullText.trim() };

  // Strip any markdown fences inside
  let inner = last.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = inner.indexOf('{');
  const end = inner.lastIndexOf('}');
  let parsed = null;
  if (first !== -1 && end !== -1) {
    try { parsed = JSON.parse(inner.slice(first, end + 1)); } catch {}
  }

  // Chat text = full minus the dashboard block
  const chatText = fullText.replace(/<dashboard>[\s\S]*?<\/dashboard>/gi, '').trim();
  return { dashboard: parsed, chatText };
}

// ---------- Assistant turn ----------

async function runAssistantTurn(facilityId) {
  const db = await readDB();
  const fac = db.facilities.find((f) => f.id === facilityId);
  if (!fac) return;

  const assistantMsg = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    ts: new Date().toISOString(),
    streaming: true,
  };
  fac.messages.push(assistantMsg);
  fac.updatedAt = new Date().toISOString();
  await writeDB(db);

  browserFanout(facilityId, 'message-start', { messageId: assistantMsg.id });

  try {
    const history = fac.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const fullText = await enqueueJob(history, facilityId, assistantMsg.id);

    const { dashboard, chatText } = parseDashboard(fullText);

    const db2 = await readDB();
    const fac2 = db2.facilities.find((f) => f.id === facilityId);
    const msg = fac2?.messages.find((m) => m.id === assistantMsg.id);
    if (msg) {
      msg.content = chatText;
      msg.streaming = false;
    }
    if (dashboard && fac2) {
      fac2.analysis = dashboard;
      // If identity includes a name, promote it to the facility name
      if (dashboard?.identity?.name) fac2.name = dashboard.identity.name;
    }
    fac2.updatedAt = new Date().toISOString();
    await writeDB(db2);

    browserFanout(facilityId, 'message-end', {
      messageId: assistantMsg.id,
      content: chatText,
    });
    if (dashboard) browserFanout(facilityId, 'dashboard', { analysis: dashboard, name: fac2.name });
  } catch (err) {
    console.error('turn failed', facilityId, err.message);
    const db3 = await readDB();
    const fac3 = db3.facilities.find((f) => f.id === facilityId);
    const msg = fac3?.messages.find((m) => m.id === assistantMsg.id);
    if (msg) {
      msg.content = `*Analysis failed: ${err.message}*`;
      msg.streaming = false;
      msg.error = true;
    }
    await writeDB(db3);
    browserFanout(facilityId, 'message-end', { messageId: assistantMsg.id, content: msg?.content || '', error: true });
  }
}

// ---------- Discovery ----------

const DISCOVER_PROMPT = (bounds) => `You are helping research Continuing Care Retirement Communities (CCRCs / Life Plan Communities) in the United States. Your task: identify CCRCs located within the geographic bounding box below. Use WebSearch and WebFetch — do NOT rely on training data alone, and do NOT invent facilities.

BOUNDING BOX (WGS84):
  South latitude: ${bounds.south}
  North latitude: ${bounds.north}
  West longitude: ${bounds.west}
  East longitude: ${bounds.east}
  Approximate center: ${((bounds.south + bounds.north) / 2).toFixed(3)}, ${((bounds.west + bounds.east) / 2).toFixed(3)}

Strategy:
  1. Identify the major US states / regions intersecting this box.
  2. WebSearch for terms like "CCRC <state>", "Life Plan Communities <region>", "LeadingAge member directory <state>", "<state> insurance department CCRC list".
  3. Pull a handful of authoritative directories and extract real facility names + addresses.
  4. Filter out anything outside the bounding box.
  5. De-duplicate.

Return ONLY this JSON object (no markdown, no prose):
{
  "discoveries": [
    {
      "name": "facility name",
      "city": "city",
      "state": "two-letter state code",
      "address": "street address if known, else null",
      "operator": "operator/parent if known, else null",
      "url": "official website URL if known, else null"
    }
  ]
}

If you find none, return {"discoveries": []}. Quality over quantity — 5 verified facilities are better than 30 invented ones.`;

function parseDiscoveries(text) {
  // Try fenced code block first, then any { ... } in the text.
  let inner = text;
  const fence = inner.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  if (fence) inner = fence[1];
  const first = inner.indexOf('{');
  const last = inner.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('no JSON in discovery output');
  const obj = JSON.parse(inner.slice(first, last + 1));
  return Array.isArray(obj.discoveries) ? obj.discoveries : [];
}

async function runDiscovery(bounds) {
  console.log(`[discover] bounds N${bounds.north.toFixed(2)} S${bounds.south.toFixed(2)} E${bounds.east.toFixed(2)} W${bounds.west.toFixed(2)}`);
  const raw = await enqueueDiscoverJob(DISCOVER_PROMPT(bounds));
  let discoveries = [];
  try { discoveries = parseDiscoveries(raw); }
  catch (err) { console.error('[discover] parse failed:', err.message); return; }

  console.log(`[discover] claude returned ${discoveries.length} candidates`);
  if (!discoveries.length) return;

  const db = await readDB();
  let added = 0;
  for (const d of discoveries) {
    if (!d.name || !d.state) continue;
    const dup = db.facilities.find(
      (f) =>
        f.name?.toLowerCase().trim() === d.name.toLowerCase().trim() &&
        (f.state || '').toLowerCase() === d.state.toLowerCase()
    );
    if (dup) continue;
    db.facilities.push({
      id: randomUUID(),
      name: d.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      analysis: null,
      notes: '',
      source: 'discovered',
      city: d.city || null,
      state: d.state || null,
      address: d.address || null,
      operator: d.operator || null,
      url: d.url || null,
      lat: null,
      lon: null,
    });
    added++;
  }
  await writeDB(db);
  console.log(`[discover] added ${added} new facilities (geocoder will resolve coords)`);
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function sendJSON(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[\\/])+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  try {
    const data = await fsp.readFile(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJSON(res, 404, { error: 'not found' });
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function tokenFromReq(req, url) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return url.searchParams.get('token') || '';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    // ---------- BRIDGE ENDPOINTS ----------
    if (pathname === '/bridge/events' && req.method === 'GET') {
      if (!BRIDGE_TOKEN || tokenFromReq(req, url) !== BRIDGE_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

      if (bridge) { try { bridge.res.end(); } catch {} clearInterval(bridge.heartbeat); }
      bridge = {
        res,
        heartbeat: setInterval(() => { try { res.write(`event: ping\ndata: {}\n\n`); } catch { cleanup(); } }, 25000),
      };
      console.log('[bridge] connected');

      const cleanup = () => {
        if (bridge && bridge.res === res) {
          clearInterval(bridge.heartbeat);
          bridge = null;
          for (const job of pendingJobs.values()) job.dispatched = false;
          console.log('[bridge] disconnected');
        }
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      flushQueueToBridge();
      return;
    }

    if (pathname === '/bridge/delta' && req.method === 'POST') {
      if (!BRIDGE_TOKEN || tokenFromReq(req, url) !== BRIDGE_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const { jobId, text } = body;
      const route = jobRouting.get(jobId);
      if (route && typeof text === 'string') {
        browserFanout(route.facilityId, 'delta', { messageId: route.assistantMessageId, text });
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/bridge/result' && req.method === 'POST') {
      if (!BRIDGE_TOKEN || tokenFromReq(req, url) !== BRIDGE_TOKEN) return sendJSON(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const { jobId, ok, data, error } = body;
      if (!jobId) return sendJSON(res, 400, { error: 'jobId required' });
      finishJob(jobId, !!ok, ok ? data : error);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- APP API ----------

    if (pathname === '/api/facilities' && req.method === 'GET') {
      const db = await readDB();
      // Library page should not show pure discoveries (no chat, no analysis).
      const visible = db.facilities.filter(
        (f) => (f.messages?.length || 0) > 0 || f.analysis
      );
      return sendJSON(res, 200, visible.map(summary));
    }

    if (pathname === '/api/map' && req.method === 'GET') {
      const db = await readDB();
      // Map shows everything that has a location (geocoded or pending).
      return sendJSON(res, 200, db.facilities.map((f) => ({
        id: f.id,
        name: f.name,
        city: f.city,
        state: f.state,
        lat: f.lat,
        lon: f.lon,
        source: f.source || 'manual',
        hasChat: (f.messages?.length || 0) > 0,
        hasDashboard: !!f.analysis,
        dealQuality: f.analysis?.scores?.deal_quality?.score ?? null,
        entityStability: f.analysis?.scores?.entity_stability?.score ?? null,
      })));
    }

    if (pathname === '/api/discover' && req.method === 'POST') {
      const body = await readBody(req);
      const { north, south, east, west } = body || {};
      if ([north, south, east, west].some((v) => typeof v !== 'number')) {
        return sendJSON(res, 400, { error: 'bounds (north, south, east, west) required as numbers' });
      }
      // Fire-and-forget discovery — return immediately, the response will
      // appear on the map as it lands.
      runDiscovery({ north, south, east, west }).catch((err) =>
        console.error('[discover] failed:', err.message)
      );
      return sendJSON(res, 202, { ok: true, queued: true });
    }

    if (pathname === '/api/facilities' && req.method === 'POST') {
      const body = await readBody(req);
      const input = (body.input || '').trim();
      if (!input) return sendJSON(res, 400, { error: 'input required' });
      const id = randomUUID();
      const db = await readDB();
      const rec = {
        id,
        name: deriveName(input),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [{ id: randomUUID(), role: 'user', content: input, ts: new Date().toISOString() }],
        analysis: null,
        notes: '',
      };
      db.facilities.unshift(rec);
      await writeDB(db);
      runAssistantTurn(id);
      return sendJSON(res, 201, { id });
    }

    const facMatch = pathname.match(/^\/api\/facilities\/([\w-]+)$/);
    if (facMatch) {
      const id = facMatch[1];
      const db = await readDB();
      const fac = db.facilities.find((f) => f.id === id);
      if (req.method === 'GET') {
        if (!fac) return sendJSON(res, 404, { error: 'not found' });
        return sendJSON(res, 200, fac);
      }
      if (req.method === 'DELETE') {
        db.facilities = db.facilities.filter((f) => f.id !== id);
        await writeDB(db);
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'PATCH') {
        if (!fac) return sendJSON(res, 404, { error: 'not found' });
        const body = await readBody(req);
        if (typeof body.notes === 'string') fac.notes = body.notes;
        await writeDB(db);
        return sendJSON(res, 200, fac);
      }
    }

    const msgMatch = pathname.match(/^\/api\/facilities\/([\w-]+)\/message$/);
    if (msgMatch && req.method === 'POST') {
      const id = msgMatch[1];
      const body = await readBody(req);
      const content = (body.content || '').trim();
      if (!content) return sendJSON(res, 400, { error: 'content required' });
      const db = await readDB();
      const fac = db.facilities.find((f) => f.id === id);
      if (!fac) return sendJSON(res, 404, { error: 'not found' });
      const userMsg = { id: randomUUID(), role: 'user', content, ts: new Date().toISOString() };
      fac.messages.push(userMsg);
      fac.updatedAt = new Date().toISOString();
      await writeDB(db);
      browserFanout(id, 'user-message', userMsg);
      runAssistantTurn(id);
      return sendJSON(res, 200, { ok: true, message: userMsg });
    }

    const streamMatch = pathname.match(/^\/api\/facilities\/([\w-]+)\/stream$/);
    if (streamMatch && req.method === 'GET') {
      const id = streamMatch[1];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: connected\ndata: {}\n\n`);

      if (!browserSubs.has(id)) browserSubs.set(id, new Set());
      browserSubs.get(id).add(res);

      const heartbeat = setInterval(() => {
        try { res.write(`event: ping\ndata: {}\n\n`); } catch { cleanup(); }
      }, 25000);

      const cleanup = () => {
        clearInterval(heartbeat);
        browserSubs.get(id)?.delete(res);
        if (browserSubs.get(id)?.size === 0) browserSubs.delete(id);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    // ---------- Pages & static ----------
    if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
    if (pathname === '/facility' || pathname === '/facility.html') return serveStatic(res, 'facility.html');
    if (pathname === '/compare' || pathname === '/compare.html') return serveStatic(res, 'compare.html');
    if (pathname === '/map' || pathname === '/map.html') return serveStatic(res, 'map.html');
    return serveStatic(res, pathname.slice(1));
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message });
  }
});

function summary(f) {
  const a = f.analysis;
  const lastMsg = f.messages?.[f.messages.length - 1];
  return {
    id: f.id,
    name: f.name,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    location: a?.identity?.location || null,
    dealQuality: a?.scores?.deal_quality?.score ?? null,
    entityStability: a?.scores?.entity_stability?.score ?? null,
    contractType: a?.contract?.type || null,
    messageCount: f.messages?.length || 0,
    hasDashboard: !!a,
    lastRole: lastMsg?.role || null,
  };
}

function deriveName(input) {
  const firstLine = input.split('\n')[0].trim();
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine || 'Untitled facility';
}

server.listen(PORT, () => {
  console.log(`\n  Kathy CCRC Analyzer`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  bridge endpoint: /bridge/events\n`);
});
