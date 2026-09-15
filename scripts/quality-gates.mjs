import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const mode = process.argv[2];
const trackedFiles = execFileSync('git', ['ls-files', '-z', '--', '*.js', '*.mjs'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file && !file.startsWith('vendor/') && !file.startsWith('scripts/'));

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
