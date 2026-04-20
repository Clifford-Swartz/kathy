// bridge.js — runs on the desktop with the `claude` CLI logged in.
// Dials the hosted site's /bridge/events SSE endpoint, receives analyze jobs
// (with conversation history), spawns `claude -p` locally, streams deltas
// back via /bridge/delta, and posts final text to /bridge/result.
//
// Config via env or .env.bridge:
//   SITE_URL       e.g. https://kathy.onrender.com  (or http://localhost:5317)
//   BRIDGE_TOKEN   shared secret (matches server env var)
//   CLAUDE_BIN     default: "claude"
//   CCRC_MODEL     default: "claude-opus-4-6"

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envFile = path.join(__dirname, '.env.bridge');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
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

// ---------- prompt composition ----------

function composePrompt(systemPrompt, messages) {
  const lines = [systemPrompt, '', '--- Conversation so far ---', ''];
  for (const m of messages) {
    const role = m.role === 'user' ? 'Kathy' : 'You';
    lines.push(`${role}: ${m.content}`);
    lines.push('');
  }
  lines.push('Respond now as "You" (the analyst). Remember: chat text outside the <dashboard> block, JSON inside it when updating the dashboard.');
  return lines.join('\n');
}

// ---------- claude spawn + streaming ----------

function runClaudeStreaming(prompt, onDelta) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', MODEL,
      // Headless mode blocks tool use on permission prompts it can't answer.
      // --dangerously-skip-permissions bypasses all checks so WebSearch,
      // WebFetch, etc. actually run. Safe here: this is your desktop, your
      // subscription, no untrusted inputs.
      '--dangerously-skip-permissions',
    ];
    // shell:true on Windows mangles paths with spaces when the binary is a
    // real .exe. Only wrap in a shell for .cmd/.bat scripts.
    const useShell = process.platform === 'win32' && !/\.exe$/i.test(CLAUDE_BIN);
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { shell: useShell, windowsHide: true });
    } catch (err) {
      return reject(err);
    }

    // Per-call state — avoids the duplicate-text bug where partial deltas
    // AND the final aggregated assistant message both get appended.
    const state = { finalText: '', sawPartialDeltas: false, fallbackResult: null };

    let buf = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        handleEvent(evt, onDelta, state);
      }
    });

    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      if (buf.trim()) {
        try { handleEvent(JSON.parse(buf.trim()), onDelta, state); } catch {}
      }
      // If we never got any streaming text, fall back to the result event.
      if (!state.finalText && state.fallbackResult) {
        onDelta(state.fallbackResult);
        state.finalText = state.fallbackResult;
      }
      resolve(state.finalText);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Claude Code's stream-json emits several event shapes. We care about
// assistant text (for the real content) AND tool_use starts (to show activity
// feedback during long research loops).
function toolIcon(name) {
  if (!name) return '🛠';
  if (/WebSearch/i.test(name)) return '🔍';
  if (/WebFetch/i.test(name)) return '🌐';
  if (/Read/i.test(name)) return '📄';
  if (/Bash/i.test(name)) return '⚙';
  return '🛠';
}

function handleEvent(evt, onDelta, state) {
  if (!evt || typeof evt !== 'object') return;

  if (evt.type === 'stream_event' && evt.event) {
    const sub = evt.event;

    // Partial text deltas — the happy path.
    if (sub.type === 'content_block_delta' && sub.delta?.type === 'text_delta') {
      const t = sub.delta.text || '';
      if (t) {
        state.sawPartialDeltas = true;
        state.finalText += t;
        onDelta(t);
      }
      return;
    }

    // Tool-use block start — show Kathy what Claude is doing.
    if (sub.type === 'content_block_start' && sub.content_block?.type === 'tool_use') {
      const name = sub.content_block.name || 'tool';
      const line = `\n\n*${toolIcon(name)} ${name}…*\n\n`;
      state.sawPartialDeltas = true;
      state.finalText += line;
      onDelta(line);
      return;
    }
  }

  // Full assistant message — ONLY use if we never got partial deltas.
  if (evt.type === 'assistant' && evt.message?.content) {
    if (state.sawPartialDeltas) return;
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        state.finalText += block.text;
        onDelta(block.text);
      } else if (block.type === 'tool_use') {
        const line = `\n\n*${toolIcon(block.name)} ${block.name || 'tool'}…*\n\n`;
        state.finalText += line;
        onDelta(line);
      }
    }
    return;
  }

  if (evt.type === 'result' && typeof evt.result === 'string') {
    state.fallbackResult = evt.result;
  }
}

// ---------- HTTP helpers ----------

async function postJSON(urlPath, body) {
  try {
    const res = await fetch(`${SITE_URL}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`[bridge] ${urlPath} -> ${res.status}`);
  } catch (err) {
    console.error(`[bridge] ${urlPath} error:`, err.message);
  }
}

async function handleJob({ jobId, systemPrompt, messages }) {
  const shortId = jobId.slice(0, 8);
  console.log(`[bridge] analyze ${shortId} — ${messages.length} msgs — running claude...`);
  const started = Date.now();

  try {
    const prompt = composePrompt(systemPrompt, messages);
    let streamedAny = false;
    const finalText = await runClaudeStreaming(prompt, (delta) => {
      streamedAny = true;
      postJSON('/bridge/delta', { jobId, text: delta });
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[bridge] analyze ${shortId} — done in ${secs}s (${finalText.length} chars)`);
    await postJSON('/bridge/result', { jobId, ok: true, data: finalText });
  } catch (err) {
    console.error(`[bridge] analyze ${shortId} — failed:`, err.message);
    await postJSON('/bridge/result', { jobId, ok: false, error: err.message });
  }
}

async function handleDiscoverJob({ jobId, prompt }) {
  const shortId = jobId.slice(0, 8);
  console.log(`[bridge] discover ${shortId} — running claude...`);
  const started = Date.now();
  try {
    // Discovery doesn't need streaming UI feedback — just run and return.
    const finalText = await runClaudeStreaming(prompt, () => {});
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[bridge] discover ${shortId} — done in ${secs}s (${finalText.length} chars)`);
    await postJSON('/bridge/result', { jobId, ok: true, data: finalText });
  } catch (err) {
    console.error(`[bridge] discover ${shortId} — failed:`, err.message);
    await postJSON('/bridge/result', { jobId, ok: false, error: err.message });
  }
}

// ---------- SSE client ----------

async function connect() {
  const url = `${SITE_URL}/bridge/events?token=${encodeURIComponent(TOKEN)}`;
  console.log('[bridge] connecting...');
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TOKEN}` },
  });
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
          handleJob(job);
        } catch (err) {
          console.error('[bridge] bad analyze payload', err);
        }
      } else if (event.event === 'discover') {
        try {
          const job = JSON.parse(event.data);
          handleDiscoverJob(job);
        } catch (err) {
          console.error('[bridge] bad discover payload', err);
        }
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
