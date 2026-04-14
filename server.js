import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5317;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'facilities.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 10 * 60 * 1000;

if (!BRIDGE_TOKEN) {
  console.warn('\n  ⚠  BRIDGE_TOKEN is not set. The bridge endpoint will reject all connections until you set it.\n');
}

await fsp.mkdir(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) await fsp.writeFile(DB_PATH, '{"facilities":[]}');

async function readDB() {
  return JSON.parse(await fsp.readFile(DB_PATH, 'utf8'));
}
async function writeDB(db) {
  const tmp = DB_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
  await fsp.rename(tmp, DB_PATH);
}

// ---------- Bridge job queue (SSE) ----------

// A single bridge is assumed (just Kathy / you). If a second bridge connects,
// it replaces the first — the old one will be disconnected.
let bridge = null; // { res, heartbeat }
const pendingJobs = new Map(); // jobId -> { prompt, facilityId, resolve, reject, dispatched, timer }

function dispatchJob(job) {
  if (!bridge) return false;
  try {
    bridge.res.write(`event: analyze\ndata: ${JSON.stringify({ jobId: job.jobId, prompt: job.prompt })}\n\n`);
    job.dispatched = true;
    return true;
  } catch (err) {
    console.error('dispatch failed', err);
    return false;
  }
}

function enqueueJob(prompt, facilityId) {
  return new Promise((resolve, reject) => {
    const jobId = randomUUID();
    const job = { jobId, prompt, facilityId, resolve, reject, dispatched: false };
    job.timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      reject(new Error('Job timed out waiting for bridge response'));
    }, JOB_TIMEOUT_MS);
    pendingJobs.set(jobId, job);
    if (bridge) dispatchJob(job);
    // else: will be dispatched when bridge connects
  });
}

function flushQueueToBridge() {
  for (const job of pendingJobs.values()) {
    if (!job.dispatched) dispatchJob(job);
  }
}

function finishJob(jobId, ok, payload) {
  const job = pendingJobs.get(jobId);
  if (!job) return;
  clearTimeout(job.timer);
  pendingJobs.delete(jobId);
  if (ok) job.resolve(payload);
  else job.reject(new Error(payload || 'bridge error'));
}

// ---------- Analysis ----------

const ANALYSIS_PROMPT = (userInput) => `You are a senior financial analyst evaluating a Continuing Care Retirement Community (CCRC / Life Plan Community) for an economist writing a book on the industry. The reader has a PhD in economics; be rigorous and quantitative.

Your job: analyze the CCRC described below and return a single JSON object (no markdown, no prose outside the JSON). Use web research if you have tools for it. If a field is unknown, use null and list it under "unknowns" — do not fabricate numbers.

Two headline questions drive the analysis:
  1. DEAL QUALITY — Is this a good financial deal for a resident buying in? (Consider entrance fee vs. refundability, contract type value, monthly fee trajectory, NPV of total lifetime cost vs. peer benchmarks.)
  2. ENTITY STABILITY — Is the operating entity financially stable? (Days cash on hand, debt service coverage, operating margin, occupancy trend, parent-org backing, bankruptcy / legal history, recent news.)

INPUT FROM THE USER (facility to analyze):
"""
${userInput}
"""

Return EXACTLY this JSON shape:
{
  "identity": {
    "name": string,
    "location": string,
    "operator": string | null,
    "parent_org": string | null,
    "url": string | null,
    "year_opened": number | null
  },
  "contract": {
    "type": "A (Life Care)" | "B (Modified)" | "C (Fee-for-Service)" | "Rental" | "Unknown",
    "summary": string,
    "what_is_covered": string[],
    "what_is_not_covered": string[]
  },
  "financial": {
    "entrance_fee_low": number | null,
    "entrance_fee_high": number | null,
    "refundable_pct": number | null,
    "monthly_fee_low": number | null,
    "monthly_fee_high": number | null,
    "fee_escalation_history_pct": number[] | null,
    "days_cash_on_hand": number | null,
    "debt_to_asset": number | null,
    "operating_margin": number | null,
    "debt_service_coverage": number | null,
    "occupancy_rate": number | null,
    "occupancy_trend": "rising" | "flat" | "declining" | "unknown"
  },
  "care_quality": {
    "medicare_star_rating": number | null,
    "carf_accredited": boolean | null,
    "recent_deficiencies": string[],
    "staff_ratio_notes": string | null
  },
  "scores": {
    "deal_quality": { "score": number, "rationale": string },
    "entity_stability": { "score": number, "rationale": string }
  },
  "red_flags": string[],
  "highlights": string[],
  "npv_analysis": {
    "assumptions": string,
    "total_cost_10yr": number | null,
    "total_cost_20yr": number | null,
    "notes": string
  },
  "narrative": string,
  "sources": { "title": string, "url": string }[],
  "unknowns": string[]
}

Scores are 0–100. Be honest — penalize missing disclosures. Narrative should be 2 tight paragraphs written for an economist. Output ONLY the JSON object.`;

function extractJSON(text) {
  let inner = text;
  try {
    const env = JSON.parse(text);
    if (env && typeof env === 'object' && typeof env.result === 'string') inner = env.result;
  } catch {}
  const fence = inner.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) inner = fence[1];
  const first = inner.indexOf('{');
  const last = inner.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object found in model output');
  return JSON.parse(inner.slice(first, last + 1));
}

async function analyzeFacility(id, rawInput) {
  try {
    const raw = await enqueueJob(ANALYSIS_PROMPT(rawInput), id);
    const parsed = extractJSON(raw);
    const db = await readDB();
    const fac = db.facilities.find((f) => f.id === id);
    if (fac) {
      fac.analysis = parsed;
      fac.status = 'ready';
      fac.analyzedAt = new Date().toISOString();
      fac.name = parsed?.identity?.name || fac.name || 'Untitled facility';
      fac.error = null;
      await writeDB(db);
    }
  } catch (err) {
    console.error('analysis failed', id, err.message);
    const db = await readDB();
    const fac = db.facilities.find((f) => f.id === id);
    if (fac) {
      fac.status = 'error';
      fac.error = err.message;
      await writeDB(db);
    }
  }
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
    // ---------- BRIDGE SSE ENDPOINT ----------
    if (pathname === '/bridge/events' && req.method === 'GET') {
      if (!BRIDGE_TOKEN || tokenFromReq(req, url) !== BRIDGE_TOKEN) {
        return sendJSON(res, 401, { error: 'unauthorized' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

      if (bridge) {
        try { bridge.res.end(); } catch {}
        clearInterval(bridge.heartbeat);
      }
      bridge = {
        res,
        heartbeat: setInterval(() => {
          try { res.write(`event: ping\ndata: {}\n\n`); }
          catch { cleanup(); }
        }, 25000),
      };
      console.log('[bridge] connected');

      const cleanup = () => {
        if (bridge && bridge.res === res) {
          clearInterval(bridge.heartbeat);
          bridge = null;
          // Any jobs that had been dispatched but hadn't returned yet
          // should be re-dispatched when a bridge reconnects.
          for (const job of pendingJobs.values()) job.dispatched = false;
          console.log('[bridge] disconnected');
        }
      };
      req.on('close', cleanup);
      req.on('error', cleanup);

      // Flush any queued jobs to the freshly-connected bridge.
      flushQueueToBridge();
      return;
    }

    if (pathname === '/bridge/result' && req.method === 'POST') {
      if (!BRIDGE_TOKEN || tokenFromReq(req, url) !== BRIDGE_TOKEN) {
        return sendJSON(res, 401, { error: 'unauthorized' });
      }
      const body = await readBody(req);
      const { jobId, ok, data, error } = body;
      if (!jobId) return sendJSON(res, 400, { error: 'jobId required' });
      finishJob(jobId, !!ok, ok ? data : error);
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/bridge/status' && req.method === 'GET') {
      return sendJSON(res, 200, {
        connected: !!bridge,
        pendingJobs: pendingJobs.size,
      });
    }

    // ---------- APP API ----------
    if (pathname === '/api/bridge-status' && req.method === 'GET') {
      return sendJSON(res, 200, { connected: !!bridge });
    }

    if (pathname === '/api/facilities' && req.method === 'GET') {
      const db = await readDB();
      return sendJSON(res, 200, db.facilities.map(summary));
    }

    if (pathname === '/api/facilities' && req.method === 'POST') {
      const body = await readBody(req);
      const rawInput = (body.input || '').trim();
      if (!rawInput) return sendJSON(res, 400, { error: 'input required' });
      const id = randomUUID();
      const db = await readDB();
      const rec = {
        id,
        name: deriveName(rawInput),
        rawInput,
        status: 'pending',
        createdAt: new Date().toISOString(),
        notes: '',
        analysis: null,
      };
      db.facilities.unshift(rec);
      await writeDB(db);
      analyzeFacility(id, rawInput); // fire and forget
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

    const retryMatch = pathname.match(/^\/api\/facilities\/([\w-]+)\/retry$/);
    if (retryMatch && req.method === 'POST') {
      const id = retryMatch[1];
      const db = await readDB();
      const fac = db.facilities.find((f) => f.id === id);
      if (!fac) return sendJSON(res, 404, { error: 'not found' });
      fac.status = 'pending';
      fac.error = null;
      await writeDB(db);
      analyzeFacility(id, fac.rawInput);
      return sendJSON(res, 200, { ok: true });
    }

    // ---------- Pages ----------
    if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
    if (pathname === '/facility' || pathname === '/facility.html') return serveStatic(res, 'facility.html');
    if (pathname === '/compare' || pathname === '/compare.html') return serveStatic(res, 'compare.html');

    return serveStatic(res, pathname.slice(1));
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: err.message });
  }
});

function summary(f) {
  const a = f.analysis;
  return {
    id: f.id,
    name: f.name,
    status: f.status,
    createdAt: f.createdAt,
    location: a?.identity?.location || null,
    dealQuality: a?.scores?.deal_quality?.score ?? null,
    entityStability: a?.scores?.entity_stability?.score ?? null,
    contractType: a?.contract?.type || null,
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
