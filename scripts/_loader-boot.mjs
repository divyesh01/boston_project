// Node --import bootstrap: registers the @/ alias resolver before ANY module
// loads, so harnesses with static `import ... from '@/lib/...'` work without
// their own register() call (which is too late for hoisted static imports).
//
// These harnesses run without a bundler/backend, so opt into the local
// (offline) auth shim — mirroring `npm run dev` with VITE_USE_LOCAL_AUTH=true.
process.env.VITE_USE_LOCAL_AUTH ??= 'true';

// DOM shims live in ONE place: scripts/_dom-shims.mjs.
//
// They used to be written out here, and a second, slightly different copy lived in
// scripts/acceptance-harness.mjs. The copies were the problem, not the shims: the
// rule they encode is delicate ("if you define `document` you MUST also define
// `location`, or axios throws at import time"), it was fixed here, and then the
// other copy broke in exactly the same way months later. See the long note at the
// top of _dom-shims.mjs for the mechanism.
import { installDomShims } from './_dom-shims.mjs';

installDomShims({ userAgent: 'harness' });

import { register } from 'node:module';
register(new URL('./resolve-alias.mjs', import.meta.url));
