import fs from 'node:fs';
import path from 'node:path';

function walkDir(dir, fileList = [], dirList = []) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dir, f.name);
      if (f.isDirectory()) {
        dirList.push(fullPath);
        walkDir(fullPath, fileList, dirList);
      } else if (f.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          fileList.push({ path: fullPath, size: stat.size });
        } catch {}
      }
    }
  } catch {}
  return { fileList, dirList };
}

const root = process.cwd();
const { fileList, dirList } = walkDir(root);

const totalBytes = fileList.reduce((acc, f) => acc + f.size, 0);
const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
const totalGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(4);
const totalFiles = fileList.length;
const totalDirs = dirList.length;

// Major folders
const majorFolders = ['src', 'node_modules', '.git', 'dist', 'scripts', 'docs', 'tests', 'base44', 'public', '.agents'];
const folderBreakdown = {};
for (const mf of majorFolders) {
  const mfPath = path.join(root, mf);
  if (fs.existsSync(mfPath)) {
    const subset = fileList.filter(f => f.path.startsWith(mfPath));
    const bytes = subset.reduce((acc, f) => acc + f.size, 0);
    folderBreakdown[mf] = {
      mb: (bytes / (1024 * 1024)).toFixed(2),
      files: subset.length
    };
  }
}

// Clean source (excluding node_modules, .git, dist, .gemini, coverage)
const excludedRegex = /[\\/](node_modules|\.git|dist|\.gemini|coverage|\.system_generated|\.turbo|\.cache)[\\/]/;
const cleanFiles = fileList.filter(f => !excludedRegex.test(f.path));
const cleanBytes = cleanFiles.reduce((acc, f) => acc + f.size, 0);
const cleanMB = (cleanBytes / (1024 * 1024)).toFixed(2);

// Source code files
const srcExts = ['.js', '.jsx', '.ts', '.tsx', '.json', '.jsonc', '.css', '.html', '.mjs', '.py', '.sql'];
const srcCodeFiles = cleanFiles.filter(f => srcExts.includes(path.extname(f.path).toLowerCase()));
const srcCodeBytes = srcCodeFiles.reduce((acc, f) => acc + f.size, 0);
const srcCodeMB = (srcCodeBytes / (1024 * 1024)).toFixed(2);

let totalLines = 0;
for (const f of srcCodeFiles) {
  try {
    const content = fs.readFileSync(f.path, 'utf8');
    totalLines += content.split('\n').length;
  } catch {}
}

// Top 20 largest files in whole repo
const top20Repo = [...fileList].sort((a, b) => b.size - a.size).slice(0, 20).map(f => ({
  relPath: path.relative(root, f.path).replace(/\\/g, '/'),
  sizeMB: (f.size / (1024 * 1024)).toFixed(3),
  sizeKB: (f.size / 1024).toFixed(2),
  bytes: f.size
}));

// Top 20 largest files in clean source
const top20Clean = [...cleanFiles].sort((a, b) => b.size - a.size).slice(0, 20).map(f => ({
  relPath: path.relative(root, f.path).replace(/\\/g, '/'),
  sizeKB: (f.size / 1024).toFixed(2),
  bytes: f.size
}));

const result = {
  totalBytes,
  totalMB,
  totalGB,
  totalFiles,
  totalDirs,
  folderBreakdown,
  cleanMB,
  cleanFilesCount: cleanFiles.length,
  srcCodeMB,
  srcCodeFilesCount: srcCodeFiles.length,
  totalLines,
  top20Repo,
  top20Clean
};

console.log(JSON.stringify(result, null, 2));
