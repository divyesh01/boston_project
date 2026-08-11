// Node --import bootstrap: registers the @/ alias resolver before ANY module
// loads, so harnesses with static `import ... from '@/lib/...'` work without
// their own register() call (which is too late for hoisted static imports).
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(new URL('./resolve-alias.mjs', import.meta.url));
