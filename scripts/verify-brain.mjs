import { execSync, execFileSync } from 'child_process';

try {
    const diff = execSync('git diff --cached --name-only').toString().trim().split('\n');
    
    const codeChanged = diff.some(f => f.startsWith('src/') || f.startsWith('base44/') || f.startsWith('scripts/'));
    const brainChanged = diff.some(f => f.includes('BRAIN') || f.includes('docs/brain/'));

    if (codeChanged && !brainChanged) {
        console.error('\n🚨 [ANTI-ROT ENFORCEMENT] ERROR: You modified source code but did not update the Brain.');
        console.error('To keep documentation 100% accurate, you MUST update a BRAIN_*.md file in docs/brain/, or BRAIN.md.');
        console.error('Commit aborted.\n');
        process.exit(1);
    }
} catch (err) {
    // Ignore if not a git repo or no staged files
}

// ─── Citation range gate (added 2026-08-25, tracker #58) ───────────────────────
// A `path.js:123` citation whose line number is past the end of the file it names
// is worse than no citation at all: the reader follows it, lands on unrelated
// code, and learns to distrust the document instead of the number. Measured
// across every tracked text file on 2026-08-25, BEFORE this change: 722
// citations, 697 resolvable, 25 unresolvable-and-skipped, 5 out of range. One of
// the five was live — a probe header citing ActionCenter.jsx:406 in a  no-cite-check
// 343-line file — and the other four are two distinct citations, each appearing
// twice, in two archived Explore reports that exist to record a past state.
//
// Scope is the STAGED DIFF'S ADDED LINES ONLY, deliberately. A gate that judged
// pre-existing content would block a commit for rot its author did not write, and
// this hook is never bypassed here (`--no-verify` is not on the table), so a
// false block means the tree cannot be committed at all.
//
// It cannot catch the other half of the problem — a citation that is IN range but
// points at the wrong line. Nothing mechanical can, without an anchor. The
// convention that does is: cite the SYMBOL, and keep line numbers for things a
// probe pins.
//
// On its own internal failure this prints loudly and exits 0 instead of blocking.
// That is the opposite of `scripts/audit-gate.mjs`'s stance and the difference is
// intentional: that gate defends a security boundary, where a green run on a
// broken gate has verified nothing; this one defends documentation accuracy,
// where the cost of a wrong block (nobody can commit anything) is higher than
// the cost of one unchecked citation. It never goes green SILENTLY.
const CITE = /([A-Za-z0-9_@./-]*[A-Za-z0-9_-]\.(?:js|jsx|mjs|cjs|ts|tsx|json|jsonc|md|yml|yaml|css|html)):(\d+)(?:\s*-\s*(\d+))?/g;
const SCAN_EXT = /\.(md|js|jsx|mjs|cjs|ts|tsx|json|jsonc|yml|yaml|css|html)$/;
// .superbrain/ and gemini-out/ hold dated snapshots of a past state on purpose:
// re-pointing their citations would falsify the record they exist to keep.
const SKIP_DIR = /^(\.superbrain|gemini-out|dist|node_modules)\//;

const git = (args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });

try {
    const indexed = new Set(git(['ls-files', '--cached']).toString().split('\n').filter(Boolean));
    const byBase = new Map();
    for (const rel of indexed) {
        const b = rel.slice(rel.lastIndexOf('/') + 1);
        if (!byBase.has(b)) byBase.set(b, []);
        byBase.get(b).push(rel);
    }

    // Line count of the STAGED blob, counted the way an editor numbers lines: a
    // file whose last byte is not \n still has a final line.
    const counts = new Map();
    const lineCountOf = (rel) => {
        if (counts.has(rel)) return counts.get(rel);
        let n = -1;
        try {
            const buf = git(['show', `:${rel}`]);
            let nl = 0;
            for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
            n = buf.length === 0 ? 0 : (buf[buf.length - 1] === 0x0a ? nl : nl + 1);
        } catch {
            n = -1;
        }
        counts.set(rel, n);
        return n;
    };

    const resolve = (raw) => {
        const norm = raw.replace(/^\.\//, '');
        if (norm.includes('/')) {
            if (indexed.has(norm)) return norm;
            const tail = [...indexed].filter((t) => t.endsWith('/' + norm));
            return tail.length === 1 ? tail[0] : null;
        }
        const c = byBase.get(norm);
        return c && c.length === 1 ? c[0] : null;
    };
    const diff = git(['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR']).toString();
    const bad = [];
    let file = null;
    let lineNo = 0;
    let checked = 0;
    let skipped = 0;

    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) {
            const p = line.slice(4).trim();
            file = p === '/dev/null' ? null : p.replace(/^b\//, '');
            if (file && (!SCAN_EXT.test(file) || SKIP_DIR.test(file))) file = null;
            continue;
        }
        if (line.startsWith('@@')) {
            const m = /^@@ -\S+ \+(\d+)/.exec(line);
            lineNo = m ? Number(m[1]) : 0;
            continue;
        }
        if (!file || !line.startsWith('+')) continue;
        const text = line.slice(1);
        const here = lineNo++;
        if (text.includes('no-cite-check')) continue;
        CITE.lastIndex = 0;
        let m;
        while ((m = CITE.exec(text)) !== null) {
            const target = resolve(m[1]);
            const n = target ? lineCountOf(target) : -1;
            if (n < 0) { skipped++; continue; }
            checked++;
            const start = Number(m[2]);
            const end = m[3] ? Number(m[3]) : start;
            if (start > n || end > n) {
                bad.push(`${file}:${here}  cites ${m[0]}  —  ${target} has ${n} lines`);
            }
        }
    }

    if (bad.length) {
        console.error('\n🚨 [CITATION GATE] A staged line cites a line past the end of the file it names:');
        for (const b of bad) console.error('   ' + b);
        console.error('\nFix the number, or cite the SYMBOL instead — symbols survive edits, line numbers do not.');
        console.error('If the citation is deliberate (sample output, a dated historical range), put');
        console.error('`no-cite-check` anywhere on the same line.');
        console.error('Commit aborted.\n');
        process.exit(1);
    }
    if (checked) {
        console.log(`[citation gate] ${checked} citation(s) in the staged diff resolve in range (${skipped} unresolved, skipped).`);
    }
} catch (err) {
    const first = err && err.message ? String(err.message).split('\n')[0] : String(err);
    console.error(`[citation gate] DID NOT RUN, so no citation was checked: ${first}`);
}