import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { React, loadSource } from './helpers/tsx-harness.mjs';

const stage = {
  apiKey: 'fictional-staging-web-key',
  projectId: 'vetcloudpro-test-stage',
  authDomain: 'vetcloudpro-test-stage.firebaseapp.com',
  appId: '1:123456789:web:synthetic',
  messagingSenderId: '123456789',
};
const select = value => loadSource('../../lib/firebase.ts', { './offline-device': {} }, {
  process: { env: value === undefined ? {} : { NEXT_PUBLIC_FIREBASE_STAGING_CONFIG: value } },
}).getFirebaseConfig();

test('an explicit staging configuration selects only the staging Firebase web app', () => {
  assert.equal(select().projectId, 'vetcloudpro');
  const config = select(JSON.stringify(stage));
  assert.equal(config.projectId, stage.projectId);
  assert.equal(config.authDomain, stage.authDomain);
  assert.equal(config.appId, stage.appId);
  assert.equal(config.apiKey, stage.apiKey);
});

test('invalid or mixed-project staging settings never fall back to production', () => {
  for (const value of ['', 'bad json', JSON.stringify(null), JSON.stringify({ projectId: stage.projectId }),
    JSON.stringify({ ...stage, projectId: 'vetcloudpro' }),
    JSON.stringify({ ...stage, authDomain: 'vetcloudpro.firebaseapp.com' }),
    JSON.stringify({ ...stage, apiKey: select().apiKey }),
    JSON.stringify({ ...stage, appId: select().appId })]) {
    assert.throws(() => select(value), /Invalid staging Firebase configuration/);
  }
});

test('staging does not use an inherited image-service endpoint', () => {
  const imageStorage = config => loadSource('../../lib/imageStore.ts', { '@/lib/firebase': {} }, {
    process: { env: { NEXT_PUBLIC_IMAGE_WORKER_URL: 'https://images.example.test', ...config } },
  }).imageStorageConfigured();
  assert.equal(imageStorage({}), true);
  assert.equal(imageStorage({ NEXT_PUBLIC_FIREBASE_STAGING_CONFIG: JSON.stringify(stage) }), false);
});

test('the isolated preview tells staff to use fictional data and does not claim to share Firebase', () => {
  const layout = env => loadSource('../../app/layout.tsx', { './globals.css': {}, '@/components/OfflineStatus': () => null }, {
    process: { env },
  }).default;
  const show = env => renderToStaticMarkup(React.createElement(layout(env), null, 'fixture'));
  const isolated = show({ VETCLOUD_STATIC_EXPORT: '1', NEXT_PUBLIC_FIREBASE_STAGING_CONFIG: JSON.stringify(stage) });
  assert.match(isolated, /fictional records only\. Isolated Firebase project/);
  assert.doesNotMatch(isolated, /Shared Firebase project/);
  assert.match(show({ VETCLOUD_STATIC_EXPORT: '1' }), /Shared Firebase project/);
});
