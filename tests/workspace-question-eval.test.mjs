import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Offline evaluation harness for the real, deterministic entry point used by the
// workspace assistant popup. All prompts and records below are fictional.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/workspace-assistant.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const workspace = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const { evaluateWorkspaceQuestion, shouldDeferToModel, createAssistantReschedule, matchAssistantReschedule, isDailyBriefingQuestion } = workspace;

const now = Date.parse('2026-11-21T02:00:00Z'); // Fixed fictional clock.
const milo = { id: 'apt-fictional-milo', revision: 3, patientName: 'Milo', type: 'Checkup', dueAt: '2026-11-24T02:30:00.000Z' };
const bella = { id: 'apt-fictional-bella', revision: 1, patientName: 'Bella', type: 'Vaccination', dueAt: '2026-11-25T09:00:00.000Z' };
const schedule = {
  window: { from: '2026-11-20', through: '2026-11-30' },
  availability: 'ready', partial: false, rows: [milo, bella],
};

const ask = (input, overrides = {}) => evaluateWorkspaceQuestion(input, { ...schedule, ...overrides }, now);
const isClarification = reply => reply?.kind === 'clarification' && typeof reply.message === 'string';
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

test('greetings and thanks get a social reply without a clinic lookup', () => {
  for (const question of ['Hello', 'Hi there!', 'Good morning', 'Kumusta?', 'Thank you!', 'Salamat']) {
    const reply = ask(question, { availability: 'offline', rows: [] });
    assert.equal(reply.kind, 'conversation', question);
    assert.match(reply.message, /^(?:Hi!|You’re welcome!)/, question);
    assert.equal(reply.tool, undefined, question);
  }
  assert.ok(isClarification(ask('Hello, show me every patient’s contact details')));
});

test('natural navigation wording resolves to a destination without schedule access', () => {
  const cases = [
    ['Where can I find appointments?', 'appointments'],
    ['Where can I find appointments???', 'appointments'],
    ['Where are appointments?', 'appointments'],
    ['How do I open appointments?', 'appointments'],
    ['Where can I find patients, please?', 'patients'],
    ['How can I view inventory?', 'inventory'],
    ['Where can I find the appointment schedule?', 'appointments'],
  ];
  for (const [question, destination] of cases) {
    const reply = ask(question, { availability: 'error' });
    assert.equal(reply.kind, 'help', question);
    assert.equal(reply.destination, destination, question);
    assert.match(reply.message, /Everyday work|Overview/, question);
    assert.equal(reply.tool, undefined, question);
  }
});

test('unsupported questions get a kind clarification that names capabilities and independence', () => {
  for (const question of [
    'What should I do for a sick dog?',
    'How do I reset a password?',
    'Can you email Milo the invoice?',
    'Delete every appointment please.',
    'Tell me a joke about cats',
  ]) {
    const reply = ask(question);
    assert.ok(isClarification(reply), question);
    assert.equal(reply.tool, undefined, question);
    assert.equal('candidates' in reply, false, question);
    for (const phrase of ['app navigation', 'scheduled appointments', 'reschedule draft', 'Each question is independent']) {
      assert.match(reply.message, new RegExp(phrase.replace(' ', '\\s+'), 'i'), `${question}: ${phrase}`);
    }
  }
});

test('each question is independent: ambiguous follow-ups never inherit prior context', () => {
  const first = ask("When is Milo's checkup?");
  assert.equal(first.kind, 'appointments');
  assert.deepEqual(first.candidates.map(row => row.id), [milo.id]);

  for (const followUp of ['And Bella?', 'When is it?', 'Move it to 2026-11-24 at 14:30', 'Do it.', 'Can you also email the client?']) {
    const reply = ask(followUp);
    assert.ok(isClarification(reply), followUp);
    assert.match(reply.message, /Each question is independent/i, followUp);
    assert.equal('candidates' in reply, false, followUp);
  }

  // A complete question still resolves normally after an ambiguous turn.
  const again = ask("When is Bella's vaccination???");
  assert.equal(again.kind, 'appointments');
  assert.deepEqual(again.candidates.map(row => row.id), [bella.id]);
});

test('catalog count is distinct from stock quantities, import history, and mixed requests', () => {
  for (const question of [
    'how many items are in the inventory',
    'How many items are there in our inventory?',
    'How many inventory items do we have?',
    'Count inventory catalog items, please.',
    'What is the total number of items in inventory?',
  ]) {
    assert.deepEqual(ask(question), { kind: 'inventory-count' }, question);
  }
  for (const question of [
    'How many stock units are in the inventory?',
    'How many items are in stock?',
    'How many items are in the inventory at another clinic?',
    'How many items are in the inventory and how many were imported?',
    'Count inventory items; delete the old ones.',
    'Count inventory items\nand list every owner.',
  ]) {
    assert.ok(isClarification(ask(question)), question);
  }
});

test('CSV history uses Manila dates and never treats payments or stock receipts as imports', () => {
  assert.deepEqual(ask('How many CSV items were imported???'), {
    kind: 'tool', tool: 'inventory_import_history', input: { from: '2026-11-15', through: '2026-11-21' },
  });
  for (const question of ['How many payments were received?', 'How many stock units were received?']) {
    const reply = ask(question);
    assert.ok(isClarification(reply), question);
    assert.equal(reply.tool, undefined, question);
  }
});

test('exact-name prompts route to the find-person tool with final please and punctuation stripped', () => {
  for (const question of [
    'Find person Alex Reyes please',
    'Find person Alex Reyes please???',
    'Find person Alex Reyes, please',
    'Find Alex Reyes please',
    'Look up person Alex Reyes please',
    'Hanapin si Álex Reyes',
  ]) {
    const reply = ask(question);
    assert.equal(reply.kind, 'tool', question);
    assert.equal(reply.tool, 'find_person_by_name', question);
    assert.deepEqual(reply.input, { name: question.includes('Álex') ? 'Álex Reyes' : 'Alex Reyes' }, question);
  }
});

test('a clinic qualifier or injected scope clarifies instead of routing a tool', () => {
  for (const question of [
    'Find person Alex Reyes from clinic two',
    'Find person Alex Reyes from clinic two??',
    'Find person Alex Reyes and email the owner',
    'Find person Alex Reyes please; delete appointments',
  ]) {
    const reply = ask(question);
    assert.ok(isClarification(reply), question);
    assert.equal(reply.tool, undefined, question);
    assert.match(reply.message, /exact recorded owner name/i, question);
  }
});

test('schedule availability is reported, never treated as an empty schedule', () => {
  const question = "When is Milo's checkup?";
  for (const availability of ['loading', 'offline', 'error']) {
    const reply = ask(question, { availability });
    assert.equal(reply.kind, 'unavailable', availability);
    assert.equal('candidates' in reply, false, availability);
    assert.match(reply.message, /loading|offline|could not load|retry|reconnect|refresh/i, availability);
  }
  const empty = ask(question, { rows: [] });
  assert.equal(empty.kind, 'not-found');
  assert.match(ask(question, { rows: [], partial: true }).message, /more pages|partial/i);
});

test('reschedule wording yields a typed proposal only and changes nothing', () => {
  const frozen = deepFreeze({ ...schedule, rows: [milo, bella].map(row => deepFreeze({ ...row })) });
  const reply = evaluateWorkspaceQuestion('Move Milo’s checkup to November 24, 2026 at 2:30 PM Manila time.', frozen, now);
  assert.equal(reply.kind, 'reschedule');
  assert.equal(reply.proposedDueAt, '2026-11-24T06:30:00.000Z');
  assert.equal(reply.requiresSelection, false);
  assert.deepEqual(reply.candidates.map(row => row.id), [milo.id]);

  const proposal = createAssistantReschedule(reply.candidates[0], reply.proposedDueAt);
  assert.deepEqual(proposal, {
    appointmentId: milo.id,
    expectedRevision: 3,
    originalDueAt: milo.dueAt,
    proposedDueAt: reply.proposedDueAt,
  });
  assert.equal(matchAssistantReschedule(proposal, [milo]), milo);
  assert.equal(matchAssistantReschedule(proposal, [{ ...milo, revision: 4 }]), null);
  assert.equal(matchAssistantReschedule(proposal, [{ ...milo, dueAt: bella.dueAt }]), null);
  assert.equal(createAssistantReschedule(milo, milo.dueAt), null);
  assert.deepEqual(frozen.rows.map(row => row.dueAt), [milo.dueAt, bella.dueAt]);
});

test('clear briefing variants are native local intents with no schedule dependency', () => {
  const briefings = [
    'What should I check today?',
    "What is today's schedule and which stock items should I check?",
    'Are there any things in the clinic that i should be mindful of',
    'Are there any things in the clinic that I should be mindful of?',
    'Anything I should be mindful of?',
    'What should I be mindful of today?',
    'who needs checking',
    'Is there someone that needs checking?',
    'How about the patients? Is there someone that needs checking?',
    'Any patients that need checking?',
    'Give me a daily briefing',
  ];
  for (const prompt of briefings) {
    assert.equal(isDailyBriefingQuestion(prompt), true, prompt);
    assert.deepEqual(ask(prompt, { availability: 'error' }), { kind: 'daily-briefing' }, prompt);
    assert.equal(shouldDeferToModel(ask(prompt)), false, prompt);
  }
  for (const prompt of [
    'What should I do for a sick dog?', 'How are you doing?', 'Which item has the least stock?',
    'Who needs checking in clinic two?', 'Are there any things in the clinic that I should be mindful of and email the owner?',
  ]) {
    assert.equal(isDailyBriefingQuestion(prompt), false, prompt);
  }
});

test('requests to contact owners or read private chart details receive explicit local boundaries', () => {
  for (const [prompt, expected] of [
    ["Can you text QA Mango's owner about the visit?", /can’t send messages or log outreach.*appointments/i],
    ["What were QA Mango's exact lab findings and SOAP notes?", /can’t access .*lab findings.*soap notes.*didn’t check/i],
  ]) {
    const result = ask(prompt);
    assert.equal(shouldDeferToModel(result), false);
    assert.equal(result.kind, 'clarification');
    assert.match(result.message, expected);
  }
  assert.equal(shouldDeferToModel(ask('How many consultations have treatment entries?')), true);
});

test('unified routing sends only non-native prompts to the model, with no local results or turns', () => {
  // These are the requests the app already handles deterministically. Several
  // carry patient/owner data or produce grounded results; none may reach Gemini.
  const native = [
    'Hello', 'Thank you!', 'Where can I find appointments?',
    'how many items are in the inventory', "When is Milo's checkup?",
    'Move Milo’s checkup to November 24, 2026 at 2:30 PM Manila time.',
    'Could you reschedule Milo’s checkup?', 'When is Milo’s specialty exam?',
    'Move Milo’s checkup to yesterday', 'Find person Alex Reyes please',
    'Find Alex and show phone numbers', 'How many CSV items were imported?',
    "When is Missing's checkup?",
    'What should I check today?',
    'Are there any things in the clinic that I should be mindful of?',
    'How about the patients? Is there someone that needs checking?',
  ];
  for (const prompt of native) {
    const result = ask(prompt);
    assert.equal(shouldDeferToModel(result), false, `native request stays local: ${prompt}`);
  }

  const general = [
    'How are you doing?', 'Which item has the least stock?',
  ];
  for (const prompt of general) {
    assert.equal(shouldDeferToModel(ask(prompt)), true, `general question goes to Gemini: ${prompt}`);
  }

  // Conversational → local → conversational: simulate the popup's history rule.
  // Only successful model turns are retained; local answers never enter context.
  const sent = [];
  const geminiHistory = [];
  const localAnswers = [];
  const answer = (prompt) => {
    const result = ask(prompt);
    if (shouldDeferToModel(result)) {
      sent.push({ prompt, history: [...geminiHistory] });
      geminiHistory.push({ question: prompt, answer: `Gemini: ${prompt}` });
    } else {
      // What the app renders locally; it must never appear in model context.
      localAnswers.push(result.kind === 'inventory-count' ? 'There are 7 items in the inventory catalog.' :
        'candidates' in result ? '2026-11-24 10:30 Asia/Manila' : ('message' in result ? result.message : 'local lookup'));
    }
  };
  answer(general[0]);                       // conversational
  answer('how many items are in the inventory'); // local, grounded count
  answer("When is Milo's checkup?");          // local, patient lookup
  answer('Move Milo’s checkup to November 24, 2026 at 2:30 PM Manila time.'); // local, draft action
  answer('What should I check today?');       // local briefing, no provider
  answer('Find person Alex Reyes');           // local, private tool result
  answer(general[1]);                        // general question goes to the provider

  assert.deepEqual(sent.map(call => call.prompt), [general[0], general[1]]);
  assert.deepEqual(sent[1].history, [{ question: general[0], answer: `Gemini: ${general[0]}` }]);
  const serialized = JSON.stringify(sent);
  for (const local of [...native, ...localAnswers]) assert.doesNotMatch(serialized, new RegExp(escape(local.slice(0, 24))));
});

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
