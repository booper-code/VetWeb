import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, deferred, loadSource, domHarness } from './helpers/tsx-harness.mjs';

for (const unmount of [false, true]) {
  test(`real Team transfer ${unmount ? 'after unmount' : 'while mounted'} updates the scoped parent role`, async () => {
    const dom = domHarness();
    const transfer = deferred();
    const roles = [], toasts = [], requests = [];
    const { ClinicTeamView } = loadSource('../../components/ClinicTeamView.tsx', {
      react: React,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/clinics': {
        listClinicMembers: async () => [
          { uid: 'owner', email: 'owner@example.com', role: 'owner' },
          { uid: 'editor', email: 'editor@example.com', role: 'editor' },
        ],
        listClinicInvitations: async () => [],
        transferClinicOwnership: (...args) => { requests.push(args); return transfer.promise; },
      },
    }, { window: dom.window });
    dom.window.confirm = () => true;
    try {
      await act(async () => dom.root.render(React.createElement(ClinicTeamView, {
        clinicId: 'synthetic', clinicName: 'Synthetic', role: 'owner',
        user: { uid: 'owner' }, onOwnershipTransferred: role => roles.push(role),
        triggerToast: message => toasts.push(message),
      })));
      const button = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent.includes('Make owner'));
      assert.ok(button);
      await act(async () => button.click());
      assert.equal(requests.length, 1, 'must reach the mocked transfer, never a live clinic');
      if (unmount) await act(() => dom.root.render(null));
      await act(async () => { transfer.resolve(); await transfer.promise; });
      assert.deepEqual(roles, ['editor']);
      assert.equal(toasts.length, unmount ? 0 : 1);
    } finally { await dom.close(); }
  });
}
