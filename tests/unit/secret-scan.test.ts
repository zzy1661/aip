import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../tools/report/context.js';

/**
 * M28：构建产物与源码中不得出现密钥。
 *
 * 断言口径：
 * - 优先扫描真正会被部署的构建产物（dist），没有构建产物时退回源码目录，
 *   但无论走哪条分支都必须给出断言结论，不允许跳过；
 * - 覆盖测试密钥字面量、各家 API key 形态、私钥块与带口令的数据库连接串。
 */
interface SecretPattern {
  label: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { label: '测试专用 HS256 密钥字面量', regex: /aip-test-only-hs256-secret/ },
  { label: '私钥块', regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { label: 'OpenAI 形态密钥', regex: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { label: 'GitHub 形态令牌', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: '带口令的数据库连接串',
    regex: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s'"@]+:[^\s'"@]+@/,
  },
];

const SCANNED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.json', '.map', '.yaml', '.yml']);

const PACKAGES = [
  { name: 'services/api', dist: 'services/api/dist', src: 'services/api/src' },
  { name: 'packages/contracts', dist: 'packages/contracts/dist', src: 'packages/contracts/src' },
  { name: 'services/worker', dist: 'services/worker/dist', src: 'services/worker/src' },
];

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      const dot = full.lastIndexOf('.');
      if (dot >= 0 && SCANNED_EXTENSIONS.has(full.slice(dot))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function resolveScanTargets(): Array<{ package: string; dir: string; origin: 'dist' | 'src' }> {
  return PACKAGES.map((pkg) => {
    const dist = resolve(repoRoot, pkg.dist);
    if (existsSync(dist)) {
      return { package: pkg.name, dir: dist, origin: 'dist' as const };
    }
    return { package: pkg.name, dir: resolve(repoRoot, pkg.src), origin: 'src' as const };
  });
}

describe('M28 密钥扫描（构建产物与源码）', () => {
  const targets = resolveScanTargets();

  it('三个包都确定了扫描目标', () => {
    expect(targets).toHaveLength(PACKAGES.length);
    for (const target of targets) {
      expect(existsSync(target.dir)).toBe(true);
    }
  });

  it('扫描目标非空且确实读到了文件', () => {
    for (const target of targets) {
      const files = listFiles(target.dir);
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it('构建产物与源码中不出现任何密钥形态', () => {
    const findings: string[] = [];
    for (const target of targets) {
      for (const file of listFiles(target.dir)) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of PATTERNS) {
          const match = pattern.regex.exec(text);
          if (match) {
            findings.push(
              `${relative(repoRoot, file)} [${target.origin}] 命中「${pattern.label}」: ${match[0].slice(0, 40)}`,
            );
          }
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('扫描口径本身有效：注入的假密钥能被同一套规则检出', () => {
    // 防止规则写坏导致扫描永远通过：用同样的模式去匹配已知假密钥。
    const samples = [
      'aip-test-only-hs256-secret',
      '-----BEGIN RSA PRIVATE KEY-----',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'postgres://user:pass@127.0.0.1:5432/db',
    ];
    for (const sample of samples) {
      expect(PATTERNS.some((pattern) => pattern.regex.test(sample))).toBe(true);
    }
  });
});
