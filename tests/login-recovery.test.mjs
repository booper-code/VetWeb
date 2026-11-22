import test from 'node:test';
import assert from 'node:assert/strict';
import { React, act, domHarness, loadSource } from './helpers/tsx-harness.mjs';

test('recovery does not disclose account status, and rejected sign-in stays in the form', async () => {
  const app = domHarness();
  const { document, HTMLInputElement, Event } = app.window;
  const auth = {};
  const sent = [];
  const loggedErrors = [];
  let errorCode;
  const { LoginScreen } = loadSource('../../components/LoginScreen.tsx', {
    '@/components/ThemeSelector': { ThemeSelector: () => null },
    '@/lib/invitation-verification': { sendInvitationVerification: () => assert.fail('Not an invitation') },
    '@/lib/firebase': { initializeFirebase: async () => ({ auth }) },
    'firebase/auth': {
      async signInWithEmailAndPassword() {
        throw { code: 'auth/invalid-credential', message: 'Raw provider details' };
      },
      async sendPasswordResetEmail(target, email) {
        assert.equal(target, auth);
        sent.push(email);
        if (errorCode) throw { code: errorCode, message: 'Raw provider details' };
      },
    },
  }, { console: { ...console, error: (...args) => loggedErrors.push(args) } });
  const click = text => act(async () => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === text);
    assert.ok(button, `Expected ${text} button`);
    button.click();
  });
  const enter = (id, text) => act(async () => {
    const input = document.getElementById(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  try {
    await act(async () => app.root.render(React.createElement(LoginScreen, { onLoginSuccess: () => assert.fail('Reset does not sign in') })));
    await enter('loginEmail', 'Fixture@Example.Com');
    await enter('loginPassword', 'fixture-secret');
    await click('Forgot password?');
    assert.equal(document.getElementById('loginPassword'), null);
    assert.equal(document.getElementById('loginEmail').value, 'Fixture@Example.Com');
    await click('Send reset link');
    const confirmation = document.querySelector('[role="status"]').textContent;
    assert.match(confirmation, /If this email is eligible/);
    for (errorCode of ['auth/user-not-found', 'auth/user-disabled']) {
      await click('Send reset link');
      assert.equal(document.querySelector('[role="status"]').textContent, confirmation);
    }
    errorCode = 'auth/network-request-failed';
    await click('Send reset link');
    assert.match(document.querySelector('[role="alert"]').textContent, /internet connection/);
    assert.doesNotMatch(document.body.textContent, /Raw provider details/);
    assert.deepEqual(sent, Array(4).fill('fixture@example.com'));
    await click('Back to sign in');
    assert.equal(document.getElementById('loginPassword').value, '');
    assert.equal(document.querySelector('[role="alert"], [role="status"]'), null);
    await enter('loginPassword', 'fictional-wrong-password');
    await click('Sign In');
    assert.equal(document.querySelector('[role="alert"] p').textContent, 'Invalid email or password.');
    assert.deepEqual(loggedErrors, []);
  } finally {
    await app.close();
  }
});
