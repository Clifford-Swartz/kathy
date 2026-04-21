// test-analysis.js — run a single DEEP DIVE analysis against the CURRENT
// SYSTEM_PROMPT without involving the live server, bridge, or DB. Use this
// to smoke-test prompt changes before deploying.
//
// Usage:
//   node test-analysis.js "Lasell Village"
//   node test-analysis.js "Lasell Village" > test-output/lasell.txt
//
// Writes:
//   test-output/<ISO timestamp>-<slug>.txt   — full assistant text
//   test-output/<ISO timestamp>-<slug>.json  — parsed dashboard (if present)
//
// The only thing this shares with prod is prompts.js. It spawns claude -p
// locally using the same CLI invocation the bridge uses.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SYSTEM_PROMPT } from './prompts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL = process.env.CCRC_MODEL || 'claude-opus-4-6';

function resolveClaudeBin() {
  const configured = process.env.CLAUDE_BIN;
  if (configured && configured !== 'claude' && fs.existsSync(configured)) return configured;
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const extDir = path.join(home, '.vscode', 'extensions');
    if (fs.existsSync(extDir)) {
      const candidates = fs.readdirSync(extDir)
        .filter((n) => /^anthropic\.claude-code-.+win32-x64$/.test(n))
        .map((name) => {
          const m = name.match(/^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)-/);
          return { name, v: m ? [+m[1], +m[2], +m[3]] : [0, 0, 0] };
        })
        .sort((a, b) => {
          for (let i = 0; i < 3; i++) if (a.v[i] !== b.v[i]) return b.v[i] - a.v[i];
          return 0;
        });
      for (const c of candidates) {
        const exe = path.join(extDir, c.name, 'resources', 'native-binary', 'claude.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return configured || 'claude';
}

const CLAUDE_BIN = resolveClaudeBin();

const facility = process.argv.slice(2).join(' ').trim();
if (!facility) {
  console.error('Usage: node test-analysis.js "Facility name or prompt"');
  process.exit(1);
}

const outDir = path.join(__dirname, 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const slug = facility.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const outBase = path.join(outDir, `${stamp}-${slug}`);

// Single-turn conversation = the same prompt shape the bridge builds.
const prompt = [
  SYSTEM_PROMPT,
  '',
  '--- Conversation so far ---',
  '',
  `Kathy: ${facility}`,
  '',
  'Respond now as "You" (the analyst). Remember: chat text outside the <dashboard> block, JSON inside it when updating the dashboard.',
].join('\n');

console.error(`[test] claude bin: ${CLAUDE_BIN}`);
console.error(`[test] model: ${MODEL}`);
console.error(`[test] facility: ${facility}`);
console.error(`[test] output: ${outBase}.{txt,json}`);
console.error('[test] running — this will take 30–180s depending on tool use...\n');

const args = [
  '-p',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--model', MODEL,
  '--dangerously-skip-permissions',
];

const useShell = process.platform === 'win32' && !/\.exe$/i.test(CLAUDE_BIN);
const started = Date.now();
const child = spawn(CLAUDE_BIN, args, { shell: useShell, windowsHide: true });

let buf = '';
let finalText = '';
let stderr = '';
const toolBlocks = {};

function toolIcon(n) {
  if (/WebSearch/i.test(n)) return '🔍';
  if (/WebFetch/i.test(n)) return '🌐';
  if (/Read/i.test(n)) return '📄';
  if (/Bash/i.test(n)) return '⚙';
  if (/Agent|Task/i.test(n)) return '🤖';
  return '🛠';
}
function describeTool(name, input) {
  if (!input || typeof input !== 'object') return name;
  const trim = (s, n = 90) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (/Agent|Task/i.test(name)) return trim(input.description || input.subagent_type || input.prompt);
  if (/WebSearch/i.test(name)) return trim(input.query);
  if (/WebFetch/i.test(name)) return trim(input.url);
  if (/Bash/i.test(name)) return trim(input.description || input.command);
  if (/Read|Write|Edit/i.test(name)) return trim(input.file_path || input.path);
  return name;
}

function handleEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (evt.type === 'stream_event' && evt.event) {
    const sub = evt.event;
    const idx = sub.index;
    if (sub.type === 'content_block_delta' && sub.delta?.type === 'text_delta') {
      const t = sub.delta.text || '';
      if (t) { finalText += t; process.stdout.write(t); }
      return;
    }
    if (sub.type === 'content_block_start' && sub.content_block?.type === 'tool_use') {
      toolBlocks[idx] = { name: sub.content_block.name || 'tool', inputBuf: '' };
      return;
    }
    if (sub.type === 'content_block_delta' && sub.delta?.type === 'input_json_delta') {
      if (toolBlocks[idx]) toolBlocks[idx].inputBuf += sub.delta.partial_json || '';
      return;
    }
    if (sub.type === 'content_block_stop' && toolBlocks[idx]) {
      const b = toolBlocks[idx];
      let input = null;
      try { input = JSON.parse(b.inputBuf); } catch {}
      const desc = describeTool(b.name, input);
      const label = desc && desc !== b.name ? `${b.name}: ${desc}` : b.name;
      const line = `\n\n[${toolIcon(b.name)} ${label}]\n`;
      finalText += line;
      process.stdout.write(line);
      delete toolBlocks[idx];
      return;
    }
  }
}

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try { handleEvent(JSON.parse(line)); } catch {}
  }
});
child.stderr.on('data', (d) => (stderr += d.toString()));
child.on('error', (err) => {
  console.error('\n[test] spawn error:', err.message);
  process.exit(1);
});
child.on('close', (code) => {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.error(`\n\n[test] finished in ${secs}s, exit ${code}, ${finalText.length} chars`);
  fs.writeFileSync(outBase + '.txt', finalText);
  console.error(`[test] wrote ${outBase}.txt`);

  // Extract dashboard JSON if present
  const re = /<dashboard>\s*([\s\S]*?)\s*<\/dashboard>/gi;
  let m, last = null;
  while ((m = re.exec(finalText)) !== null) last = m[1];
  if (last) {
    let inner = last.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const first = inner.indexOf('{');
    const end = inner.lastIndexOf('}');
    if (first !== -1 && end !== -1) {
      try {
        const parsed = JSON.parse(inner.slice(first, end + 1));
        fs.writeFileSync(outBase + '.json', JSON.stringify(parsed, null, 2));
        console.error(`[test] wrote ${outBase}.json`);
        // Print a quick summary to stderr
        console.error('\n[test] summary:');
        console.error('  name:              ', parsed?.identity?.name);
        console.error('  contract type:     ', parsed?.contract?.type);
        console.error('  deal quality:      ', parsed?.scores?.deal_quality?.score, '—', parsed?.scores?.deal_quality?.rationale?.slice(0, 80));
        console.error('  entity stability:  ', parsed?.scores?.entity_stability?.score, '—', parsed?.scores?.entity_stability?.rationale?.slice(0, 80));
        console.error('  red flags:         ', (parsed?.red_flags || []).length);
        console.error('  sources cited:     ', (parsed?.sources || []).length);
        console.error('  field sources:     ', Object.keys(parsed?.field_sources || {}).filter(k => !k.startsWith('//')).length);
      } catch (err) {
        console.error('[test] dashboard parse failed:', err.message);
      }
    }
  } else {
    console.error('[test] no <dashboard> block found');
  }

  if (code !== 0) {
    console.error('[test] stderr:', stderr.slice(0, 500));
    process.exit(code);
  }
});

child.stdin.write(prompt);
child.stdin.end();
