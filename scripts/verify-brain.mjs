import { execSync } from 'child_process';

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