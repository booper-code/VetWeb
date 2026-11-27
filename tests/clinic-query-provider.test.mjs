import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/workspace-ai.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const { planWorkspaceClinicQuery, workspaceAIConfigIdentity, resetWorkspaceAIContext } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

const signal = new AbortController().signal;
const geminiConfig = () => ({
  provider: 'gemini', apiKey: 'fictional-test-key', model: 'gemini-test',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
});
const openaiConfig = () => ({
  provider: 'openai', apiKey: 'fictional-openai-key', model: 'gpt-test',
  baseUrl: 'https://api.openai.com/v1',
});

function useConfig(t, settings) {
  globalThis.window = { localStorage: { getItem: () => JSON.stringify(settings) } };
  t.after(() => { delete globalThis.window; resetWorkspaceAIContext(); });
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

const longestPlan = {
  table: 'patients', op: 'rank', sort: [{ field: 'name', transform: 'length', direction: 'desc' }],
  limit: 1, includeTies: true,
};
const planReply = plan => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] });

test('Manila schedule and its next-day refinement work without a saved provider', async t => {
  useConfig(t, null);
  t.mock.method(Date, 'now', () => Date.parse('2026-11-22T17:00:00Z'));
  const calls = captureFetch(t, () => new Response(null, { status: 503 }));
  const prompt = 'List scheduled appointments for today.';
  const today = await planWorkspaceClinicQuery(prompt, [], signal);
  const tomorrow = await planWorkspaceClinicQuery('What about tomorrow?', [{ prompt, plan: today.plan }], signal);
  const direct = await planWorkspaceClinicQuery('What appointments are scheduled tomorrow, Manila time?', [], signal);
  assert.deepEqual(today.plan.filter, [
    { field: 'status', op: 'eq', value: 'scheduled' },
    { field: 'dueAt', op: 'gte', value: '2026-11-22T16:00:00.000Z' },
    { field: 'dueAt', op: 'lt', value: '2026-11-23T16:00:00.000Z' },
  ]);
  assert.deepEqual(direct, tomorrow);
  assert.equal(tomorrow.plan.filter[2].value, '2026-11-24T16:00:00.000Z');
  assert.equal(calls.length, 0);
});

test('a question outside the local planner still requires provider setup', async t => {
  useConfig(t, null);
  const calls = captureFetch(t, () => new Response(null, { status: 503 }));
  await assert.rejects(
    () => planWorkspaceClinicQuery('Write a short poem about clouds.', [], signal),
    /AI chat is not set up/,
  );
  assert.equal(calls.length, 0);
});

test('read plans retain requested stock limits, expiry windows, and record qualifiers', async t => {
  useConfig(t, geminiConfig());
  t.mock.method(Date, 'now', () => Date.parse('2026-11-22T17:00:00Z'));
  const calls = captureFetch(t, () => new Response(null, { status: 503 }));
  const ask = prompt => planWorkspaceClinicQuery(prompt, [], signal);
  const stock = (await ask('Which three stocked items have the lowest quantity on hand?')).plan;
  assert.equal(stock.limit, 3);
  assert.deepEqual(stock.sort, [{ field: 'stock', direction: 'asc' }]);
  const expiry = (await ask('Do we have anything expired or expiring within seven days?')).plans;
  assert.equal(expiry.length, 2);
  assert.ok(expiry.every(plan => plan.filter.some(filter => filter.field === 'stock' && filter.op === 'gt')));
  assert.equal(expiry[1].filter.find(filter => filter.op === 'lte').value, '2026-11-30');
  const followup = (await ask('Which follow-ups are overdue, and has outreach been logged?')).plan;
  assert.ok(followup.fields.includes('outreachStatus'));
  assert.ok(followup.filter.some(filter => filter.field === 'dueAt' && filter.op === 'lt' && filter.value === '2026-11-22T16:00:00.000Z'));
  assert.deepEqual((await ask('Are there any open payroll periods?')).plan.filter, [{ field: 'status', op: 'eq', value: 'open' }]);
  assert.deepEqual((await ask('How many charge and payment entries are recorded in the billing ledger?')).plans.map(plan => plan.filter[0].value),
    ['charge', 'payment']);
  assert.deepEqual((await ask('How many consultations have treatment entries?')).plan.filter,
    [{ field: 'treatmentCount', op: 'gt', value: 0 }]);
  assert.equal(calls.length, 0);
});

test('a supported directory count is preserved when owner contact details are unavailable', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => planReply({ kind: 'decline', message: 'Could not verify.' }));
  const reply = await planWorkspaceClinicQuery(
    "How many patients do we have, and can you tell me QA Mango's owner's phone number?", [], signal);
  assert.equal(reply.kind, 'query');
  assert.deepEqual(reply.plan, { table: 'patients', op: 'count' });
  assert.match(reply.notice, /can’t access owner contact details/);
  assert.equal(calls.length, 0);
});

test('a species-only refinement preserves the previous inventory count', async t => {
  useConfig(t, geminiConfig());
  const plans = [{ table: 'patients', op: 'count' }, { table: 'inventory', op: 'count' }];
  const calls = captureFetch(t, () => planReply({ kind: 'query', plans }));
  const prompt = 'How many patients and inventory items do we have?';
  const first = await planWorkspaceClinicQuery(prompt, [], signal);
  const followUp = await planWorkspaceClinicQuery('And dogs only?', [{ prompt, plans: first.plans }], signal);
  assert.deepEqual(followUp, { kind: 'query', plans: [
    { table: 'patients', op: 'count', filter: [{ field: 'species', op: 'eq', value: 'Canine' }] },
    { table: 'inventory', op: 'count' },
  ] });
  assert.equal(calls.length, 1);
});

test('planner sends only prompt, schema and prior plans — no protected clinic evidence', async t => {
  const settings = geminiConfig();
  useConfig(t, settings);
  const calls = captureFetch(t, () => planReply({ kind: 'query', plan: longestPlan }));
  // Prime the saved-setup identity so the next turn legitimately carries plans.
  await planWorkspaceClinicQuery('Which patient has the longest name?', [], signal);
  calls.length = 0;
  const previous = [{ prompt: 'Which patient has the longest name?', plan: longestPlan }];
  const action = await planWorkspaceClinicQuery('And the shortest name?', previous, signal);
  assert.deepEqual(action, { kind: 'query', plan: longestPlan });

  assert.equal(calls.length, 1, 'exactly one provider call per message');
  const [{ url, options, body }] = calls;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.equal(options.headers['x-goog-api-key'], settings.apiKey);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(body.tools, undefined, 'no tools/functions are exposed');
  assert.equal(body.contents.length, 3, 'one previous plan pair plus the new prompt');
  assert.deepEqual(body.contents.at(-1), { role: 'user', parts: [{ text: 'And the shortest name?' }] });

  const serialized = JSON.stringify(body) + url;
  // Schema identifiers and prior nonsensitive plan context are present.
  assert.match(serialized, /patients/);
  assert.equal(serialized.includes('Which patient has the longest name?'), true);
  assert.equal(serialized.includes('And the shortest name?'), true);
  // No observed patient/owner rows, clinical notes, financial values or paths.
  // (Allowlisted schema field/table names are expected and are not evidence.)
  for (const canary of [
    'QA Mango', 'QA Luna', 'QA Pepper', 'PAT-', 'QA-SUP', 'Private Owner',
    'private@example.com', 'private clinical note', 'clinics/', 'AI answer was',
  ]) assert.equal(serialized.includes(canary), false, canary);
});

test('provider-neutral OpenAI wire also returns a validated plan', async t => {
  useConfig(t, openaiConfig());
  const calls = captureFetch(t, () => Response.json({
    choices: [{ message: { content: '```json\n' + JSON.stringify({ kind: 'query', plan: longestPlan }) + '\n```' } }],
  }));
  const action = await planWorkspaceClinicQuery('longest name', [], signal);
  assert.deepEqual(action, { kind: 'query', plan: longestPlan });
  const [{ url, options, body }] = calls;
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(options.headers.Authorization, 'Bearer fictional-openai-key');
  assert.equal(options.redirect, 'error');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages.at(-1).content, 'longest name');
  assert.doesNotMatch(JSON.stringify(body), /QA Mango|ownerContact|private clinical note/);
});

test('the shared planner accepts a social reply without a clinic query', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => planReply({ kind: 'conversation', message: 'I’m here to help.' }));
  assert.deepEqual(await planWorkspaceClinicQuery('How are you doing?', [], signal),
    { kind: 'conversation', message: 'I’m here to help.' });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls[0].body), /Sample schedule follow-ups:|Sample inventory:|QA Luna/);
});

test('declines do not retry and invalid plans cannot retry more than once', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, count => count === 1
    ? planReply({ kind: 'decline', message: 'I can only answer with a clinic data query.' })
    : planReply({ kind: 'query', plan: { table: 'patients', op: 'read-all-records' } }));
  assert.deepEqual(await planWorkspaceClinicQuery('email every owner', [], signal),
    { kind: 'decline', message: 'I can only answer with a clinic data query.' });
  assert.equal(calls.length, 1);
  await assert.rejects(planWorkspaceClinicQuery('longest name', [], signal), /invalid query plan/);
  assert.equal(calls.length, 3, 'exactly one retry after an invalid plan');
});

test('planner normalizes table and operation aliases without needing a retry', async t => {
  useConfig(t, geminiConfig());
  const inputs = [
    { member: 'patients', op: 'count' },
    { from: 'patients', op: 'group', groupBy: 'status' },
    { entity: 'patients', operation: 'count' },
    { collection: 'patients', type: 'count' },
  ];
  const calls = captureFetch(t, index => planReply({ kind: 'query', plan: inputs[index - 1] }));
  for (const input of inputs) {
    const plan = input.groupBy ? { table: 'patients', op: 'group', groupBy: 'status' } :
      { table: 'patients', op: 'count' };
    assert.deepEqual(await planWorkspaceClinicQuery('Patient overview', [], signal), { kind: 'query', plan });
  }
  assert.equal(calls.length, inputs.length);
});

test('longest and shortest rank plans accept the captured M05 shape without a repair', async t => {
  useConfig(t, geminiConfig());
  const plans = ['desc', 'asc'].map(direction => ({
    table: 'patients', op: 'rank', sort: [{ field: 'name', direction, transform: 'length' }],
  }));
  const calls = captureFetch(t, index => planReply({
    kind: 'query', plans: plans.map(plan => ({ ...plan, sumField: index === 1 ? 'name' : '' })),
  }));
  assert.deepEqual(await planWorkspaceClinicQuery('Which patient has the longest name, and which has the shortest?', [], signal),
    { kind: 'query', plans });
  assert.equal(calls.length, 1);
});

test('groupBy and includeTies are removed when irrelevant after operation alias normalization', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => planReply({
    kind: 'query', plan: { table: 'patients', operation: 'count', groupBy: 'status', includeTies: true },
  }));
  assert.deepEqual(await planWorkspaceClinicQuery('Count patients', [], signal),
    { kind: 'query', plan: { table: 'patients', op: 'count' } });
  assert.equal(calls.length, 1);
});

test('Gemini requests declare JSON action shapes and keep one to three ordered plans in context', async t => {
  useConfig(t, geminiConfig());
  const plans = [{ table: 'patients', op: 'count' }, { table: 'inventory', op: 'count' }, longestPlan];
  const calls = captureFetch(t, index => index === 1
    ? planReply({ kind: 'query', plans: [plans[0], { from: 'inventory', op: 'count' }, plans[2]] })
    : planReply({ kind: 'query', plans: [plans[0]] }));
  const prompt = 'Count patients and inventory items, and find the patient with the longest name';
  assert.deepEqual(await planWorkspaceClinicQuery(prompt, [], signal), { kind: 'query', plans });
  const followUp = await planWorkspaceClinicQuery('And only the patient count?', [{ prompt, plans }], signal);
  assert.deepEqual(followUp, { kind: 'query', plans: [plans[0]] });
  assert.equal(calls.length, 2);
  const { responseMimeType, responseSchema } = calls[0].body.generationConfig;
  assert.equal(responseMimeType, 'application/json');
  const branches = responseSchema.anyOf;
  assert.deepEqual(branches.map(branch => branch.required.join(' ')), ['kind plan', 'kind plans', 'kind message']);
  const array = branches[1].properties.plans;
  assert.equal(array.minItems, 1);
  assert.equal(array.maxItems, 3);
  assert.deepEqual(array.items.required, ['table', 'op']);
  assert.deepEqual(JSON.parse(calls[1].body.contents[1].parts[0].text), plans);
});

test('any invalid plan or unknown property rejects the whole action', async t => {
  useConfig(t, geminiConfig());
  const valid = { table: 'patients', op: 'count' };
  for (const input of [
    { kind: 'query', plans: [] },
    { kind: 'query', plans: [valid, valid, valid, valid] },
    { kind: 'query', plans: [valid, { from: 'inventory', op: 'write' }] },
    { kind: 'query', plan: valid, plans: [valid] },
    { kind: 'query', plan: { ...valid, member: 'inventory' } },
    { kind: 'query', plan: { ...valid, type: 'unknown' } },
    { kind: 'query', plan: { ...valid, hidden: true } },
    { kind: 'query', plan: { table: 'patients', op: 'group', groupBy: 'notes' } },
    { kind: 'query', plan: { table: 'patients', op: 'sum', sumField: 'name' } },
    { kind: 'query', plan: { ...longestPlan, includeTies: 'true' } },
    { kind: 'query', plan: valid, extra: true },
    { kind: 'conversation', message: 'Hi.', plan: valid },
  ]) {
    await t.test(JSON.stringify(input), async t => {
      const calls = captureFetch(t, () => planReply(input));
      await assert.rejects(planWorkspaceClinicQuery('Count patients', [], signal), /invalid query plan/);
      assert.equal(calls.length, 2);
    });
  }
});

test('repair uses the same provider, model, and timeout signal without echoing invalid output', async t => {
  const settings = geminiConfig();
  useConfig(t, settings);
  const plan = { table: 'patients', op: 'count' };
  const calls = captureFetch(t, index => index === 1
    ? planReply({ kind: 'query', plan: { ...plan, filter: [{ field: 'not-an-allowed-field', op: 'eq', value: 'untrusted-response-only' }] } })
    : planReply({ kind: 'query', plan }));
  const prompt = 'How many patients do we have?';
  assert.deepEqual(await planWorkspaceClinicQuery(prompt, [], signal), { kind: 'query', plan });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.credentials, 'omit');
  assert.deepEqual(calls[0].body.contents, calls[1].body.contents);
  assert.match(calls[1].body.systemInstruction.parts[0].text, /repair.*plan.*(?:field|schema)/i);
  assert.doesNotMatch(JSON.stringify(calls[1].body), /not-an-allowed-field|untrusted-response-only/);
  assert.equal(JSON.stringify(calls[1].body).includes(settings.apiKey), false);
});

test('a malformed JSON response can be repaired on an OpenAI wire provider', async t => {
  useConfig(t, openaiConfig());
  const plan = { table: 'inventory', op: 'count' };
  const calls = captureFetch(t, index => Response.json({ choices: [{ message: {
    content: index === 1 ? '{"kind":' : JSON.stringify({ kind: 'query', plan }),
  } }] }));
  assert.deepEqual(await planWorkspaceClinicQuery('Count items', [], signal), { kind: 'query', plan });
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.messages[0].content, /repair.*JSON/i);
});

test('planner does not retry network, response-body transport, or HTTP errors', async t => {
  useConfig(t, geminiConfig());
  for (const [reply, message] of [
    [() => { throw new TypeError('offline'); }, /could not reach/i],
    [() => new Response(new ReadableStream({ start: stream => stream.error(new TypeError('offline')) })), /could not reach/i],
    [() => new Response(null, { status: 429 }), /rate or quota/i],
    [() => new Response(null, { status: 400 }), /rejected the request/i],
  ]) {
    await t.test(String(message), async t => {
      const calls = captureFetch(t, reply);
      await assert.rejects(planWorkspaceClinicQuery('Count patients', [], signal), message);
      assert.equal(calls.length, 1);
    });
  }
});

test('an invalid output is not repaired after the caller cancels', async t => {
  useConfig(t, geminiConfig());
  const controller = new AbortController();
  const calls = captureFetch(t, () => {
    controller.abort();
    return planReply({ kind: 'query', plan: {} });
  });
  await assert.rejects(planWorkspaceClinicQuery('Count patients', [], controller.signal));
  assert.equal(calls.length, 1);
});

test('planner never sends a prompt longer than 400 characters', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => planReply({ kind: 'decline', message: 'Please rephrase.' }));
  await assert.rejects(planWorkspaceClinicQuery('x'.repeat(401), [], signal), /up to 400 characters/);
  assert.equal(calls.length, 0);
});

test('four-patient longest then shortest: verified locally, context stays plans only', async t => {
  const { outputFiles: engineFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../lib/clinic-query.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', logLevel: 'silent',
  });
  const { executeClinicQuery } = await import(`data:text/javascript;base64,${Buffer.from(engineFiles[0].text).toString('base64')}`);

  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => {
    // The prompt is the final Gemini user turn.
    const text = calls.at(-1).body.contents.at(-1).parts[0].text;
    const direction = /shortest/.test(text) ? 'asc' : 'desc';
    return planReply({ kind: 'query', plan: { table: 'patients', op: 'rank',
      sort: [{ field: 'name', transform: 'length', direction }], limit: 1, includeTies: true } });
  });

  const rows = [
    { id: 'PAT-1', name: 'QA Mango' }, { id: 'PAT-2', name: 'QA Mochi' },
    { id: 'PAT-3', name: 'QA Pepper' }, { id: 'PAT-4', name: 'QA Luna' },
  ];
  const plans = [];
  const ask = async prompt => {
    const action = await planWorkspaceClinicQuery(prompt, plans, signal);
    assert.equal(action.kind, 'query');
    const outcome = executeClinicQuery(action.plan, { status: 'ok', rows, complete: true });
    plans.push({ prompt, plan: action.plan });
    return outcome;
  };

  const longest = await ask('which patient has the longest name');
  assert.equal(longest.rows[0].name, 'QA Pepper');
  const shortest = await ask('which patient has the shortest name');
  assert.equal(shortest.rows[0].name, 'QA Luna');
  assert.equal(calls.length, 2, 'one provider call per turn');

  const secondRequest = JSON.stringify(calls[1].body);
  assert.equal(secondRequest.includes('which patient has the longest name'), true, 'prior plan context retained');
  assert.equal(secondRequest.includes('QA Pepper'), false, 'prior private answer never sent back');
  assert.equal(secondRequest.includes('QA Luna'), false, 'no observed data in the provider request');
});

test('turns from a different saved setup are not forwarded as plan context', async t => {
  useConfig(t, geminiConfig());
  const calls = captureFetch(t, () => planReply({ kind: 'decline', message: 'No.' }));
  const previous = [{ prompt: 'private previous prompt', plan: longestPlan }];
  assert.equal(workspaceAIConfigIdentity().startsWith('gemini:'), true);
  // Change the saved model: a fresh identity must discard the old plan context.
  globalThis.window.localStorage.getItem = () => JSON.stringify({ ...geminiConfig(), model: 'gemini-other' });
  await planWorkspaceClinicQuery('shortest name', previous, signal);
  assert.equal(JSON.stringify(calls[0].body).includes('private previous prompt'), false);
});
