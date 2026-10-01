/**
 * 构建部署目录 dist/
 * ------------------------------------------------------------------
 * 本作品是无打包器的原生 ES Module 应用，运行所需文件就是：
 *   index.html + src/ + vendor/
 * 所以“构建”= 只把这部分运行时文件复制到 dist/，
 * 严格排除 tests/、docs/、scripts/、server.js、node_modules/、.git/ 与任何密钥。
 *
 * 用法： node scripts/build.mjs
 */
import { rm, mkdir, cp, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');

/** 运行时必须的文件/目录 */
const INCLUDE = ['index.html', 'favicon.ico', 'src', 'vendor', 'media'];

/** 绝不允许进入部署目录的东西 */
const FORBIDDEN = [
  'node_modules', '.git', '.github', '.vibehub', 'tests', 'docs', 'scripts',
  'server.js', 'package.json', 'package-lock.json', 'README.md', 'LICENSE',
  '.gitignore', '.gitattributes', 'dist',
];
const FORBIDDEN_EXT = ['.md', '.log', '.env', '.pem', '.key', '.zip', '.map'];
const FORBIDDEN_NAME = [/secret/i, /token/i, /credential/i, /\.env$/i];

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (FORBIDDEN.includes(e.name)) continue;
      await walk(p, base, out);
    } else {
      out.push(relative(base, p));
    }
  }
  return out;
}

const t0 = Date.now();
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

let copied = 0;
for (const entry of INCLUDE) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) continue;
  const st = await stat(src);
  if (st.isDirectory()) {
    await cp(src, join(DIST, entry), { recursive: true });
  } else {
    await cp(src, join(DIST, entry));
  }
  copied++;
}

// 安全审计：部署目录里不允许出现被禁内容
const files = await walk(DIST);
const bad = files.filter((f) => {
  const name = f.split('/').pop();
  if (FORBIDDEN_NAME.some((re) => re.test(f))) return true;
  if (FORBIDDEN_EXT.some((ext) => f.toLowerCase().endsWith(ext))) return true;
  return false;
});
if (bad.length) {
  console.error('❌ 部署目录包含被禁文件：\n  ' + bad.join('\n  '));
  process.exit(1);
}
const topHasIndex = existsSync(join(DIST, 'index.html'));
if (!topHasIndex) {
  console.error('❌ dist/ 顶层缺少 index.html');
  process.exit(1);
}

// 写一份构建信息（便于排查线上版本）
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const total = (await Promise.all(files.map(async (f) => (await stat(join(DIST, f))).size))).reduce((a, b) => a + b, 0);
await writeFile(join(DIST, 'build-info.txt'),
  `name: ${pkg.name}\nversion: ${pkg.version}\nbuilt: ${new Date().toISOString()}\nfiles: ${files.length}\n`, 'utf8');

console.log(`✅ dist/ 构建完成：${files.length} 个文件，${(total / 1024 / 1024).toFixed(2)} MiB，用时 ${Date.now() - t0}ms`);
console.log('   顶层 index.html：有');
console.log('   入口目录：' + INCLUDE.filter((e) => existsSync(join(DIST, e))).join(', '));
