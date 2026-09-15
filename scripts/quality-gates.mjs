import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const ignored = (file) => file.replaceAll('\\', '/').startsWith('vendor/') || file.replaceAll('\\', '/').startsWith('scripts/');
const trackedFiles = listTrackedFiles();

function listTrackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs'], { encoding: 'utf8' })
      .split('\0')
      .filter((file) => file && !ignored(file));
  } catch {
    return [...rootFiles(), ...['src', 'public', 'test'].flatMap((root) => walkFiles(root, 0))];
  }
}

function rootFiles() {
  const files = [];
  let entries;
  try {
    entries = readdirSync('.', { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if ((entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) && !ignored(entry.name)) {
      files.push(entry.name);
    }
  }
  return files;
}

function walkFiles(dir, depth) {
  if (depth > 4) return [];
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...walkFiles(path, depth + 1));
    } else if ((entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) && !ignored(path)) {
      files.push(path.replace(/^[./]+/, '').replaceAll('\\', '/'));
    }
  }
  return files;
}

if (!['--syntax', '--lint', '--format'].includes(mode)) {
  console.error('usage: node scripts/quality-gates.mjs --syntax|--lint|--format');
  process.exit(2);
}

if (mode === '--syntax' || mode === '--lint') {
  execFileSync(process.execPath, ['--check', 'scripts/quality-gates.mjs'], { stdio: 'inherit' });
  for (const file of trackedFiles) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}

if (mode === '--lint') {
  const violations = trackedFiles.flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.flatMap((line, index) => /(^|\s)debugger(?:\s|;|$)/.test(line) ? [`${file}:${index + 1}: debugger statement`] : []);
  });
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exit(1);
  }
}

if (mode === '--format') {
  const violations = trackedFiles.flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.flatMap((line, index) => /[ \t]+$/.test(line) ? [`${file}:${index + 1}: trailing whitespace`] : []);
  });
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exit(1);
  }
}
