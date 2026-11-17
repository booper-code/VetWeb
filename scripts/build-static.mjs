import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const build = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VETCLOUD_STATIC_EXPORT: '1' }
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

// Cloudflare static-asset response headers. This is a test-only deployment.
writeFileSync(new URL('../out/_headers', import.meta.url), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Robots-Tag: noindex, nofollow, noarchive
/
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /
/manifest.webmanifest
  Cache-Control: no-cache
`, { flag: 'w' });
