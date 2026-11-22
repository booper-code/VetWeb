import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/workspace-ai.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const {
  askWorkspaceAI, matchesWorkspaceAISample, workspaceAISampleReadLimit, workspaceAISamplePatientIds,
  workspaceAISampleAppointmentReadLimit, summarizeWorkspaceAIFollowUps, workspaceAIConfigIdentity,
  resetWorkspaceAIContext,
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const now = Date.parse('2026-11-21T02:00:00Z');
const luna = {
  patientId: workspaceAISamplePatientIds[3], patientName: 'QA Luna',
  status: 'scheduled', type: 'Follow-up', dueAt: '2026-11-20T15:59:00.000Z',
};
const signal = new AbortController().signal;
const history = Array.from({ length: 7 }, (_, i) => ({ question: `Question ${i}`, answer: `Answer ${i}` }));
const canaries = /fictional-test-key|fictional-openai-key|QA-SUP|PAT-|buyingPrice|clinicId|Question 0|Private Owner|private@example.com|private clinical note|private staff id/;

function useConfig(t, settings) {
  globalThis.window = { localStorage: { getItem: () => settings ? JSON.stringify(settings) : null } };
  t.after(() => { delete globalThis.window; });
  resetWorkspaceAIContext();
}

function captureFetch(t, reply) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return reply(calls.length);
  });
  return calls;
}

const geminiConfig = () => ({
  provider: 'gemini', apiKey: 'fictional-test-key', model: 'gemini-test',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
});

test('sample follow-ups distinguish Manila days, stale contact, and incomplete evidence', () => {
  const today = { ...luna, dueAt: '2026-11-20T16:00:00.000Z', followUpContact: { dueAt: luna.dueAt } };
  const overdue = { ...luna, followUpContact: { dueAt: luna.dueAt } };
  assert.deepEqual(summarizeWorkspaceAIFollowUps([
    today, overdue, { ...luna, dueAt: '2026-11-21T16:00:00.000Z' },
    { ...luna, status: 'canceled' }, { ...luna, type: 'Checkup' },
  ], now), { partial: false, due: [
    { patient: 'QA Luna', date: '2026-11-20', timing: 'overdue', outreach: 'logged' },
    { patient: 'QA Luna', date: '2026-11-21', timing: 'due today', outreach: 'not logged' },
  ] });
  assert.equal(summarizeWorkspaceAIFollowUps([], now), null);
  assert.equal(summarizeWorkspaceAIFollowUps([{ ...luna, patientId: 'unlisted' }], now), null);
  assert.deepEqual(summarizeWorkspaceAIFollowUps([{ ...luna, status: 'completed' }], now), { partial: false, due: [] });
  assert.deepEqual(summarizeWorkspaceAIFollowUps([
    { ...luna, dueAt: '' }, { ...luna, patientName: 'Different patient' },
  ], now), { partial: true, due: [] });
  const capped = summarizeWorkspaceAIFollowUps(Array(workspaceAISampleAppointmentReadLimit).fill(luna), now);
  assert.equal(capped.partial, true);
  assert.equal(capped.due.length, workspaceAISampleAppointmentReadLimit - 1);
});

test('preview accepts only the nine unchanged sample items, ignoring non-stocked placeholders', async () => {
  const csv = await readFile(new URL('../docs/sample-inventory-qa.csv', import.meta.url), 'utf8');
  const rows = csv.trim().split('\n').slice(1).map(line => {
    const [, id, itemName, category, stock] = /^(QA-[^,]+),(.+?),(Medicine|Supplies|Service|Grooming),(\d+),/.exec(line);
    return { id, itemName: itemName.replace(/^"|"$/g, ''), category, stock: /Service|Grooming/.test(category) ? 999 : Number(stock) };
  });
  assert.equal(workspaceAISampleReadLimit, rows.length + 1);
  assert.equal(matchesWorkspaceAISample(rows.toReversed()), true);
  assert.equal(matchesWorkspaceAISample(rows.slice(1)), false);
  assert.equal(matchesWorkspaceAISample([...rows, { id: 'extra' }]), false);
  assert.equal(matchesWorkspaceAISample([{ ...rows[0], itemName: 'Real item' }, ...rows.slice(1)]), false);
  assert.equal(matchesWorkspaceAISample([{ ...rows[0], stock: 5 }, ...rows.slice(1)]), false);
});

test('Gemini wire: exact official endpoint, key header, bounded history, no tools or raw records', async t => {
  const settings = geminiConfig();
  useConfig(t, settings);
  let status = 200;
  const calls = captureFetch(t, () => Response.json({
    candidates: [{ content: { parts: [{ text: 'ignored trace', thought: true }, { text: 'There are 9 sample items.' }] } }],
  }, { status }));
  assert.equal(await askWorkspaceAI('How many?', history, signal, [{
    ...luna, ownerName: 'Private Owner', ownerEmail: 'private@example.com', notes: 'private clinical note',
    followUpContact: { dueAt: luna.dueAt, contactedBy: 'private staff id' },
  }], now), 'There are 9 sample items.');
  const [{ url, options, body }] = calls;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(options.headers['x-goog-api-key'], settings.apiKey);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.method, 'POST');
  assert.equal(body.tools, undefined);
  assert.equal(body.contents.length, 9);
  assert.equal(body.contents[0].parts[0].text, 'Question 3');
  assert.deepEqual(body.contents.at(-1), { role: 'user', parts: [{ text: 'How many?' }] });
  const serialized = JSON.stringify(body) + url;
  assert.match(serialized, /Sample exam gloves/);
  assert.match(serialized, /QA Luna.*2026-11-20.*overdue/);
  assert.doesNotMatch(serialized, canaries);
  status = 429;
  await assert.rejects(askWorkspaceAI('Hello', [], signal), /quota/);
  assert.equal(calls.length, 2, 'one request per send even when the provider fails');
});

test('OpenAI wire: exact registered endpoint, bearer key, system + bounded history, no leak', async t => {
  const settings = { provider: 'openai', apiKey: 'fictional-openai-key', model: 'test-model', baseUrl: 'https://api.openai.com/v1' };
  useConfig(t, settings);
  const calls = captureFetch(t, () => Response.json({ choices: [{ message: { content: 'An OpenAI-compatible reply.' } }] }));
  assert.equal(await askWorkspaceAI('How many?', history, signal, [luna], now), 'An OpenAI-compatible reply.');
  const [{ url, options, body }] = calls;
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(options.headers.Authorization, `Bearer ${settings.apiKey}`);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(body.model, 'test-model');
  assert.equal(body.tools, undefined);
  assert.equal(body.messages.length, 10, 'system + four history turns + latest prompt');
  assert.equal(body.messages[0].role, 'system');
  assert.deepEqual(body.messages[1], { role: 'user', content: 'Question 3' });
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: 'How many?' });
  const serialized = JSON.stringify(body) + url;
  assert.match(serialized, /Sample exam gloves/);
  assert.doesNotMatch(serialized, canaries);
  assert.doesNotMatch(url, /fictional-openai-key/);
});

test('Ollama uses the exact registered loopback endpoint with no key or auth header', async t => {
  useConfig(t, { provider: 'ollama', apiKey: '', model: 'llama3.1', baseUrl: 'http://localhost:11434/v1' });
  const calls = captureFetch(t, () => Response.json({ choices: [{ message: { content: 'Local reply.' } }] }));
  assert.equal(await askWorkspaceAI('Hello', [], signal), 'Local reply.');
  const [{ url, options }] = calls;
  assert.equal(url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.redirect, 'error');
  assert.equal(calls.length, 1);
});

test('custom and edited/unverified endpoints fail closed with no request; trailing slash is normalized', async t => {
  const calls = captureFetch(t, () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  useConfig(t, { provider: 'custom', apiKey: 'x', model: 'm', baseUrl: 'https://somewhere.example/v1' });
  await assert.rejects(askWorkspaceAI('Hello', [], signal), /Clinic setup/);
  useConfig(t, { provider: 'openai', apiKey: 'x', model: 'm', baseUrl: 'https://not-openai.example/v1' });
  await assert.rejects(askWorkspaceAI('Hello', [], signal), /Clinic setup/);
  useConfig(t, { provider: 'unknown', apiKey: 'x', model: 'm', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  await assert.rejects(askWorkspaceAI('Hello', [], signal), /Clinic setup/);
  assert.equal(calls.length, 0, 'no automatic send to an unverified URL');
  useConfig(t, { ...geminiConfig(), baseUrl: 'https://generativelanguage.googleapis.com/v1beta/' });
  assert.equal(await askWorkspaceAI('Hello', [], signal), 'ok');
  assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
});

test('no saved config or no key fails closed with provider-neutral setup guidance', async t => {
  const calls = captureFetch(t, () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  useConfig(t, null);
  await assert.rejects(askWorkspaceAI('Hello', [], signal), /not set up/);
  useConfig(t, { provider: 'openai', apiKey: '', model: 'm', baseUrl: 'https://api.openai.com/v1' });
  await assert.rejects(askWorkspaceAI('Hello', [], signal), /Clinic setup/);
  assert.equal(calls.length, 0, 'the local workflow stays working without a saved key');
});

test('changing the saved setup drops history from the previous provider', async t => {
  const settings = geminiConfig();
  useConfig(t, settings);
  const calls = captureFetch(t, () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  const firstIdentity = workspaceAIConfigIdentity();
  assert.match(firstIdentity, /^gemini:/);
  await askWorkspaceAI('First', [{ question: 'Previous provider turn', answer: 'Secret previous answer' }], signal);
  assert.match(JSON.stringify(calls[0].body), /Secret previous answer/);
  settings.apiKey = 'a-different-key';
  settings.model = 'gemini-other';
  assert.notEqual(workspaceAIConfigIdentity(), firstIdentity, 'changing model/key changes the identity');
  await askWorkspaceAI('Second', [{ question: 'Previous provider turn', answer: 'Secret previous answer' }], signal);
  assert.doesNotMatch(JSON.stringify(calls[1].body), /Secret previous answer/, 'no previous setup history is forwarded');
  assert.match(JSON.stringify(calls[1].body), /Second/);
});

test('empty or oversized prompts never create a request', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => Response.json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  await assert.rejects(askWorkspaceAI('   ', [], signal), /Enter a message/);
  await assert.rejects(askWorkspaceAI('x'.repeat(401), [], signal), /Enter a message/);
  assert.equal(calls.length, 0);
});
