import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, loadSource, domHarness } from './helpers/tsx-harness.mjs';

for (const role of ['owner', 'member']) {
  test(`team access controls are scoped to the Owner (${role} session)`, async () => {
    const dom = domHarness();
    const requests = [];
    const { ClinicTeamView } = loadSource('../../components/ClinicTeamView.tsx', {
      react: React,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/clinics': {
        listClinicMembers: async () => [
          { uid: 'owner', email: 'owner@example.com', role: 'owner' },
          { uid: 'member', email: 'member@example.com', role: 'member' },
        ],
        listClinicInvitations: async () => [],
        removeClinicMember: async (...args) => { requests.push(args); },
      },
    }, { window: dom.window });
    dom.window.confirm = () => true;
    try {
      await act(async () => dom.root.render(React.createElement(ClinicTeamView, {
        clinicId: 'synthetic', clinicName: 'Synthetic', role,
        user: { uid: role }, triggerToast: () => {},
      })));
      const buttons = [...dom.window.document.querySelectorAll('button')];
      assert.equal(buttons.some(button => /make owner/i.test(button.textContent)), false);
      assert.equal(buttons.some(button => /create invite/i.test(button.textContent)), role === 'owner');
      const remove = buttons.find(button => /remove/i.test(button.textContent));
      assert.equal(Boolean(remove), role === 'owner');
      if (remove) await act(async () => remove.click());
      assert.deepEqual(requests, role === 'owner' ? [['synthetic', 'member']] : []);
    } finally { await dom.close(); }
  });
}
