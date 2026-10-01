/**
 * 静态检查：对 src 下所有模块做 node --check，并尝试导入非 DOM 模块。
 * 用法： node scripts/check.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const ROOT = resolve(new URL('..', import.meta.url).pathname);

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = await walk(join(ROOT, 'src'));
let bad = 0;
for (const f of files) {
  try { await exec(process.execPath, ['--check', f]); }
  catch (e) { bad++; console.log('❌ 语法', f.replace(ROOT, '.'), '\n', String(e.stderr).split('\n').slice(0, 4).join('\n')); }
}
console.log(`语法检查：${files.length} 个文件，${bad} 个失败`);

// 导入检查（无 DOM 的模块）
const domFree = files.filter((f) => !/src\/(ui|main)/.test(f));
for (const f of domFree) {
  try {
    await import('file://' + f);
  } catch (e) {
    bad++;
    console.log('❌ 导入', f.replace(ROOT, '.'), '->', e.message);
  }
}
console.log(`导入检查：${domFree.length} 个模块`);
process.exit(bad ? 1 : 0);
