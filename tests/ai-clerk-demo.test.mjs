import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../lib/ai-clerk-demo.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', logLevel: 'silent',
});
const { reviewClerkDemoNote } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

test('a creation proposal uses the explicit type, duration, patient ID, and Manila time', () => {
  assert.deepEqual(reviewClerkDemoNote('Create a 45-minute follow-up for DEMO-PAT-101 on 2026-11-24 at 00:30'), {
    kind: 'proposal',
    proposal: {
      action: 'create', patientId: 'DEMO-PAT-101', patientName: 'Cora',
      appointmentType: 'Follow-up', durationMinutes: 45, scheduledAtMs: Date.parse('2026-11-23T16:30:00Z'),
    },
  });
});

test('rescheduling shows both fixture and proposed times; cancelling targets the original fixture', () => {
  const original = {
    appointmentId: 'DEMO-APT-201', patientId: 'DEMO-PAT-101', patientName: 'Cora',
    appointmentType: 'Checkup', durationMinutes: 30,
  };
  assert.deepEqual(reviewClerkDemoNote('Reschedule DEMO-APT-201 to 2026-11-25 at 14:30'), {
    kind: 'proposal',
    proposal: { ...original, action: 'reschedule', previousAtMs: Date.parse('2026-11-24T02:30:00Z'),
      scheduledAtMs: Date.parse('2026-11-25T06:30:00Z') },
  });
  assert.deepEqual(reviewClerkDemoNote('Cancel DEMO-APT-201'), {
    kind: 'proposal',
    proposal: { ...original, action: 'cancel', scheduledAtMs: Date.parse('2026-11-24T02:30:00Z') },
  });
});

test('unsupported, incomplete, or ambiguous notes ask for clarification and produce no proposal', () => {
  const cases = [
    ['', /one fictional note/i],
    ['x'.repeat(161), /160 characters/],
    ['Create a 30-minute checkup for Cora on 2026-11-24 at 09:00', /fictional patient ID/i],
    ['Create a 30-minute checkup for PAT-00101 on 2026-11-24 at 09:00', /fictional patient ID/i],
    ['Create a 1-minute checkup for DEMO-PAT-101 on 2026-11-24 at 09:00', /duration/i],
    ['Create a 30-minute treatment for DEMO-PAT-101 on 2026-11-24 at 09:00', /appointment type/i],
    ['Create a checkup for DEMO-PAT-101 on 2026-11-24 at 09:00', /date.*time/i],
    ['Reschedule DEMO-APT-201 to tomorrow at 09:00', /date.*time/i],
    ['Reschedule DEMO-APT-201 to 2026-02-30 at 09:00', /valid date and time/i],
    ['Reschedule DEMO-APT-201 to 2026-11-24 at 24:00', /valid date and time/i],
    ['Reschedule DEMO-APT-201 to 2026-11-24 at 10:30', /different time/i],
    ['Cancel DEMO-APT-999', /fictional appointment ID/i],
    ['Cancel DEMO-APT-201\nCancel DEMO-APT-999', /one fictional note/i],
    ['Cancel DEMO-APT-201 and send a message', /date.*time/i],
    ['Charge DEMO-PAT-101 500', /date.*time/i],
  ];
  for (const [note, message] of cases) {
    const result = reviewClerkDemoNote(note);
    assert.equal(result.kind, 'clarification', note);
    assert.match(result.message, message, note);
    assert.equal('proposal' in result, false, note);
  }
});
