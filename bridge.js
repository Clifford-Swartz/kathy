// bridge.js — runs on the desktop that has the `claude` CLI logged in.
// Dials the hosted site's /bridge/events SSE endpoint, receives analyze jobs,
// spawns `claude -p` locally, and POSTs results back to /bridge/result.
//
// Config via env vars (or a .env.bridge file in this directory):
//   SITE_URL       e.g. https://kathy.onrender.com
//   BRIDGE_TOKEN   shared secret (matches server env var)
//   CLAUDE_BIN     optional, default: "claude"
//   CCRC_MODEL     optional, default: "claude-opus-4-6"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny .env loader so you don't need dotenv.
const envFile = path.join(__dirname, '.env.bridge');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

const SITE_URL = (process.env.SITE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.BRIDGE_TOKEN || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CCRC_MODEL || 'claude-opus-4-6';

if (!SITE_URL || !TOKEN) {
  console.error('Missing SITE_URL or BRIDGE_TOKEN. Set them in env or .env.bridge.');
  process.exit(1);
}

console.log(`[bridge] site: ${SITE_URL}`);
console.log(`[bridge] model: ${MODEL}  claude bin: ${CLAUDE_BIN}`);

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', MODEL];
    const child = spawn(CLAUDE_BIN, args, {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      resolve(stdout);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function postResult(jobId, ok, payload) {
  try {
    const res = await fetch(`${SITE_URL}/bridge/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(
        ok ? { jobId, ok: true, data: payload } : { jobId, ok: false, error: String(payload) }
      ),
    });
    if (!res.ok) console.error('[bridge] result POST failed', res.status, await res.text());
  } catch (err) {
    console.error('[bridge] result POST error', err.message);
  }
}

async function handleJob({ jobId, prompt }) {
  console.log(`[bridge] job ${jobId.slice(0, 8)} — running claude...`);
  const started = Date.now();
  try {
    const out = await runClaude(prompt);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[bridge] job ${jobId.slice(0, 8)} — done in ${secs}s`);
    await postResult(jobId, true, out);
  } catch (err) {
    console.error(`[bridge] job ${jobId.slice(0, 8)} — failed:`, err.message);
    await postResult(jobId, false, err.message);
  }
}

// Minimal SSE client on top of fetch + ReadableStream.
async function connect() {
  const url = `${SITE_URL}/bridge/events?token=${encodeURIComponent(TOKEN)}`;
  console.log('[bridge] connecting...');
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'text/event-stream', 'Authorization': `Bearer ${TOKEN}` },
    });
  } catch (err) {
    throw new Error('fetch failed: ' + err.message);
  }
  if (!res.ok) throw new Error('SSE connect failed: ' + res.status);
  if (!res.body) throw new Error('no response body');
  console.log('[bridge] connected ✓');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended');
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = parseSSE(chunk);
      if (!event) continue;
      if (event.event === 'analyze') {
        try {
          const job = JSON.parse(event.data);
          handleJob(job); // fire and forget; many jobs can run in parallel if needed
        } catch (err) {
          console.error('[bridge] bad analyze payload', err);
        }
      } else if (event.event === 'ping') {
        // heartbeat
      } else if (event.event === 'hello') {
        // server greeting
      }
    }
  }
}

function parseSSE(chunk) {
  const out = { event: 'message', data: '' };
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) out.event = line.slice(6).trim();
    else if (line.startsWith('data:')) out.data += line.slice(5).trim();
  }
  return out.data || out.event !== 'message' ? out : null;
}

async function loop() {
  let backoff = 1000;
  while (true) {
    try {
      await connect();
    } catch (err) {
      console.error('[bridge]', err.message);
    }
    console.log(`[bridge] reconnecting in ${backoff}ms...`);
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30000);
  }
}

loop();
