import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _incomingNodeEnv = process.env.NODE_ENV || '';
if (_incomingNodeEnv === 'production' && !process.env.CLERK_PROBE_RESPAWNED) {
  const _child = await import('node:child_process');
  const _r = _child.spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { env: { ...process.env, NODE_ENV: 'development', CLERK_PROBE_RESPAWNED: '1', CLERK_PROBE_PARENT_ENV: _incomingNodeEnv }, stdio: 'inherit' });
  process.exit(_r.status ?? 1);
}
function getArg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const DEFAULT_REPO = path.resolve(__dirname, '..');
const repoRoot = path.resolve(getArg('--repo', DEFAULT_REPO));
const sourceArg = getArg('--source', path.join(repoRoot, 'src', 'pages', 'Employees.jsx'));
function resolveSource(repo, srcArg) {
  const cands = [];
  if (path.isAbsolute(srcArg)) cands.push(srcArg);
  cands.push(path.resolve(process.cwd(), srcArg));
  cands.push(path.resolve(__dirname, srcArg));
  cands.push(path.join(repo, srcArg));
  cands.push(path.join(repo, 'src', 'pages', srcArg));
  for (const c of cands) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return path.resolve(process.cwd(), srcArg);
}
const SOURCE_PATH = resolveSource(repoRoot, sourceArg);
const repoRequire = createRequire(path.join(repoRoot, 'package.json'));
const esbuild = repoRequire('esbuild');
const { JSDOM } = repoRequire('jsdom');
function setupJsdom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const g = globalThis;
  g.window = dom.window;
  g.document = dom.window.document;
  try { g.navigator = dom.window.navigator; } catch { try { Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true }); } catch {} }
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.Event = dom.window.Event;
  g.CustomEvent = dom.window.CustomEvent;
  g.MouseEvent = dom.window.MouseEvent;
  g.KeyboardEvent = dom.window.KeyboardEvent;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  g.cancelAnimationFrame = (id) => clearTimeout(id);
  g.matchMedia = g.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  if (!g.IntersectionObserver) g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!g.ResizeObserver) g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
function loadComponent(sourceText, mocks) {
  const React = repoRequire('react');
  const transformed = esbuild.transformSync(sourceText, { loader: 'jsx', format: 'cjs', target: 'es2020' }).code;
  const moduleObj = { exports: {} };
  function fakeRequire(id) {
    if (id === 'react') return React;
    if (id in mocks) return mocks[id];
    try { return repoRequire(id); } catch (e) { throw new Error('fakeRequire cannot resolve: ' + id + ' :: ' + e.message); }
  }
  const fn = new Function('require', 'module', 'exports', transformed);
  fn(fakeRequire, moduleObj, moduleObj.exports);
  const comp = moduleObj.exports.default || moduleObj.exports.Employees;
  if (!comp) throw new Error('default export not found');
  return comp;
}
function buildMocks(state) {
  const React = repoRequire('react');
  const Card = ({ title, children }) => React.createElement('div', { 'data-mock': 'Card', 'data-title': title }, children);
  const KpiCard = (p) => React.createElement('div', { 'data-mock': 'KpiCard' }, String(p.label || ''));
  const ClerkAuditMatrix = () => React.createElement('div', { 'data-mock': 'ClerkAuditMatrix' });
  const ErrorState = () => React.createElement('div', { 'data-mock': 'ErrorState' });
  const Tabs = {
    __esModule: true,
    Root: ({ children }) => React.createElement('div', null, children),
    List: ({ children }) => React.createElement('div', null, children),
    Trigger: ({ children }) => React.createElement('button', null, children),
    Content: ({ children }) => React.createElement('div', null, children),
  };
  const motion = { div: (p) => { const { children, ...rest } = p || {}; const { layoutId, transition, ...domProps } = rest; return React.createElement('div', domProps, children); } };
  const iconFn = () => React.createElement('span', { 'data-icon': 'icon' });
  return {
    'react': React,
    '@radix-ui/react-tabs': Tabs,
    'framer-motion': { __esModule: true, motion },
    'lucide-react': { __esModule: true, Users: iconFn, AlertTriangle: iconFn, CheckCircle2: iconFn, ChevronDown: iconFn, ChevronUp: iconFn, Info: iconFn },
    '@/components/ui-exec/Card': { __esModule: true, default: Card },
    '@/components/ui-exec/KpiCard': { __esModule: true, default: KpiCard },
    '@/components/dashboard/ClerkAuditMatrix': { __esModule: true, default: ClerkAuditMatrix },
    '@/components/ui/status': { __esModule: true, ErrorState },
    '@/lib/useHotelData': {
      __esModule: true,
      useClerkRecords: () => ({ data: state.liveRecords, isLoading: false, isError: false, error: null, refetch: state.refetch }),
      useAdjustmentsRefunds: () => ({ data: [], isLoading: false, isError: false, error: null, refetch: async () => ({}) }),
      useClerkAnomalies: () => ({ data: [], isLoading: false, isError: false, error: null, refetch: async () => ({}) }),
    },
    '@/lib/useGlobalFilters': {
      __esModule: true,
      useGlobalFilters: () => ({
        dateRange: { from: '2026-10-01', to: '2026-10-03' },
        property: 'A',
        properties: [{ id: 'A', name: 'Property A' }],
        employee: 'all',
      }),
    },
    '@/lib/anomalySignoff': { __esModule: true, signOffShiftAnomaly: state.signOffStub },
    '@/api/base44Client': { __esModule: true, db: { auth: { me: async () => ({ id: 'mgr-1', username: 'Manager', email: 'mgr@test' }) } } },
    '@/lib/hotel': {
      __esModule: true,
      money2: (n) => '$' + Number(n || 0).toFixed(2),
      num: (n) => String(n),
      C: { purple: '', cyan: '', green: '', coral: '', amber: '' },
    },
    '@/lib/anomalyDetector': { __esModule: true, detectClerkAnomalies: () => ({ flaggedAnomalies: [], clerkRiskScores: {} }) },
    '@/lib/propertyRecordIdentity': {
      __esModule: true,
      propertyRecordKey: (rec, clerk) => `${rec.property_id ?? ''}::${clerk}`,
      propertyDisplayName: (s) => s.property_name || s.property_id || '',
    },
  };
}
function pendingRecord() {
  return { id: 'shift-A1', record_type: 'clerk_payment', clerk_name: 'Alice', property_id: 'A', property_name: 'Property A', amount: 100, payment_type: 'CASH', transaction_count: 1, created_date: '2026-10-01', review_status: 'PENDING', resolution_notes: '' };
}
function resolvedRecord(notes) {
  const r = pendingRecord();
  r.review_status = 'RESOLVED'; r.resolution_notes = notes;
  r.reviewed_by_id = 'mgr-1'; r.reviewed_by_name = 'Manager';
  return r;
}
async function runVariant(label, sourceText) {
  const React = repoRequire('react');
  const TL = repoRequire('@testing-library/react');
  const { render, waitFor, cleanup } = TL;
  const { act } = repoRequire('react-dom/test-utils');
  const state = { liveRecords: [pendingRecord()], signOffCalls: [] };
  let refetchStarted = false;
  let refetchCalls = 0;
  let released = false;
  let releaseRefetch = () => {};
  const refetchGate = new Promise((res) => { releaseRefetch = () => { if (!released) { released = true; res(); } }; });
  state.refetch = async () => { refetchCalls++; refetchStarted = true; await refetchGate; return { data: state.liveRecords }; };
  state.signOffStub = async (args) => { state.signOffCalls.push(args); return { ok: true }; };
  const mocks = buildMocks(state);
  const Employees = loadComponent(sourceText, mocks);
  const out = { label, signOffCalls: state.signOffCalls, refetchCalls: 0, steps: [] };
  let unmount = null;
  try {
    cleanup();
    document.body.innerHTML = '';
    const { fireEvent } = TL;
    let view;
    await act(async () => { const r = render(React.createElement(Employees)); unmount = r.unmount; view = r; });
    const q = (t) => view.queryByText(t);
    const g = (t) => view.getByText(t);
    await waitFor(() => { if (!q('Alice')) throw new Error('pending Alice row not visible'); }, { timeout: 5000 });
    out.steps.push('pending-row-visible:OK');
    const aliceEl = g('Alice');
    const row = aliceEl.closest('tr');
    if (!row) throw new Error('clerk <tr> not found for Alice');
    fireEvent.click(row);
    await waitFor(() => { if (!view.queryByText(/Sign Off Shift|Signing\.\.\.|Signed Off/)) throw new Error('signoff button not rendered after expand'); }, { timeout: 5000 });
    out.steps.push('expand:OK');
    const notesInput = view.getByLabelText('Resolution notes for Alice');
    fireEvent.change(notesInput, { target: { value: 'verified cash' } });
    out.steps.push('notes:OK');
    const btn = g('Sign Off Shift');
    fireEvent.click(btn);
    await waitFor(() => { if (state.signOffCalls.length !== 1) throw new Error('signOff not yet called once, got ' + state.signOffCalls.length); }, { timeout: 5000 });
    await waitFor(() => { if (!refetchStarted) throw new Error('refetch not started after signOff'); }, { timeout: 5000 });
    out.steps.push('signoff-once+refetch-started:OK');
    const c0 = state.signOffCalls[0];
    if (c0.shiftId !== 'shift-A1' || c0.managerUserId !== 'mgr-1' || c0.resolutionNotes !== 'verified cash' || c0.propertyId !== 'A') {
      throw new Error('signOff args mismatch: ' + JSON.stringify(c0));
    }
    out.steps.push('signoff-args:OK');
    await waitFor(() => { if (!q('Signing...')) throw new Error('expected Signing... while refetch pending'); }, { timeout: 5000 });
    const signingBtn = g('Signing...');
    if (signingBtn.disabled !== true) throw new Error('Signing... button not disabled');
    out.steps.push('signing-disabled-while-pending:OK');
    fireEvent.click(signingBtn);
    await new Promise((r) => setTimeout(r, 300));
    if (state.signOffCalls.length !== 1) throw new Error('second click caused duplicate signOff, count=' + state.signOffCalls.length);
    out.steps.push('no-second-call:OK');
    state.liveRecords = [resolvedRecord('verified cash')];
    releaseRefetch();
    await waitFor(() => { if (!q('Signed Off')) throw new Error('expected Signed Off after fresh RESOLVED records'); }, { timeout: 8000 });
    const signedBtn = g('Signed Off');
    if (signedBtn.disabled !== true) throw new Error('Signed Off button not disabled');
    out.steps.push('signed-off-disabled-after-refresh:OK');
    out.refetchCalls = refetchCalls;
    out.pass = true;
  } catch (e) {
    out.pass = false;
    out.error = String((e && e.message) || e).split('\n')[0];
    out.refetchCalls = refetchCalls;
  } finally {
    try { releaseRefetch(); } catch {}
    try { if (unmount) unmount(); } catch {}
    try { cleanup(); } catch {}
    try { document.body.innerHTML = ''; } catch {}
  }
  return out;
}
const candidateSrc = fs.readFileSync(SOURCE_PATH, 'utf8');
if (!candidateSrc.includes('await recordsQ.refetch')) {
  console.log(JSON.stringify({ fatal: 'loaded source missing await recordsQ.refetch', source: SOURCE_PATH }));
  process.exit(2);
}
const baselineSrc = candidateSrc.replace('await recordsQ.refetch?.();', 'recordsQ.refetch?.();');
if (baselineSrc === candidateSrc) {
  console.log(JSON.stringify({ fatal: 'baseline await-strip failed' }));
  process.exit(2);
}
setupJsdom();
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const realResult = await runVariant('candidate-await', candidateSrc);
console.log('VARIANT-RESULT ' + JSON.stringify({ label: realResult.label, pass: realResult.pass, steps: realResult.steps, signOffCalls: realResult.signOffCalls, refetchCalls: realResult.refetchCalls, error: realResult.error || null }));
const baseResult = await runVariant('baseline-fire-and-forget', baselineSrc);
console.log('VARIANT-RESULT ' + JSON.stringify({ label: baseResult.label, pass: baseResult.pass, steps: baseResult.steps, signOffCalls: baseResult.signOffCalls, refetchCalls: baseResult.refetchCalls, error: baseResult.error || null }));
const EXPECTED5 = ['pending-row-visible:OK', 'expand:OK', 'notes:OK', 'signoff-once+refetch-started:OK', 'signoff-args:OK'];
const baselineFailTight = baseResult.pass === false
  && typeof baseResult.error === 'string'
  && baseResult.error.startsWith('expected Signing... while refetch pending')
  && JSON.stringify(baseResult.steps) === JSON.stringify(EXPECTED5);
const { createHash } = await import('node:crypto');
const fullHash = 'sha256:' + createHash('sha256').update(candidateSrc).digest('hex');
const summary = {
  candidatePass: realResult.pass === true && realResult.steps.length === 8,
  baselineFail: baselineFailTight,
  candidateSteps: realResult.steps.length,
  baselineSteps: baseResult.steps.length,
  baselineError: baseResult.error || null,
  source: SOURCE_PATH,
  repo: repoRoot,
  candidateHash: fullHash,
  runtimeEnv: { incoming: process.env.CLERK_PROBE_PARENT_ENV || _incomingNodeEnv || null, effective: process.env.NODE_ENV || null, respawned: process.env.CLERK_PROBE_RESPAWNED === '1' },
};
console.log('PROOF-SUMMARY ' + JSON.stringify(summary));
if (summary.candidatePass && summary.baselineFail) { console.log('DEFERRED-REFETCH-PROOF: PASS'); console.log('PASSED: probe-clerk-signoff-refetch — candidate 8 steps; expected mutant lock rejection after 5 steps'); process.exit(0); }
console.log('DEFERRED-REFETCH-PROOF: FAIL');
process.exit(1);
