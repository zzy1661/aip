import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录：本文件位于 tools/report/，上溯两级。 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export interface GitState {
  sha: string;
  /** 已跟踪文件是否有改动。 */
  dirty: boolean;
  changed_tracked: string[];
  untracked: string[];
}

/**
 * 读取被测代码的 git 状态。
 *
 * dirty 只看已跟踪文件：报告目录本身是未跟踪的生成物，
 * 把它算进 dirty 会让每次出报告的运行都自称不干净。
 */
export function gitState(): GitState {
  const changed = git(['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter((line) => line.length > 0);
  const untracked = git(['status', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim());
  return {
    sha: git(['rev-parse', 'HEAD']),
    dirty: changed.length > 0,
    changed_tracked: changed,
    untracked,
  };
}

export function sha256Of(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function fileSha256(path: string): string | null {
  try {
    return sha256Of(readFileSync(path));
  } catch {
    return null;
  }
}

/** 依赖锁文件哈希：锁文件变了就说明依赖面变了。 */
export function dependencyLockHash(): string | null {
  return fileSha256(join(repoRoot, 'pnpm-lock.yaml'));
}

export interface MigrationDigest {
  file: string;
  sha256: string;
}

/** 迁移台账指纹：列出全部迁移文件及其内容哈希。 */
export function migrationDigests(): MigrationDigest[] {
  const dir = join(repoRoot, 'services/api/src/db/migrations');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => ({ file: name, sha256: fileSha256(join(dir, name)) ?? '' }));
  } catch {
    return [];
  }
}

/** 报告目录：reports/<git-sha>/<mode>/。 */
export function reportDir(mode: string): string {
  return join(repoRoot, 'reports', gitState().sha || 'unknown', mode);
}

export interface TraceRecord {
  kind: 'case' | 'request';
  [key: string]: unknown;
}

/**
 * 追加一条运行期记录。
 *
 * 报告是副产物，写出失败不允许影响测试结论，因此这里吞掉异常。
 */
export function appendTraceRecord(mode: string, record: TraceRecord): void {
  try {
    const dir = reportDir(mode);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, '.trace.jsonl'), `${JSON.stringify(record)}\n`);
  } catch {
    // 忽略：报告写出失败不能改写用例结论。
  }
}

/** 清空本模式的运行期记录，避免上一次运行的记录混入本次报告。 */
export function resetTraceRecords(mode: string): void {
  try {
    const file = join(reportDir(mode), '.trace.jsonl');
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // 忽略：同上。
  }
}

export function readTraceRecords(mode: string): TraceRecord[] {
  try {
    const raw = readFileSync(join(reportDir(mode), '.trace.jsonl'), 'utf8');
    const records: TraceRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        records.push(JSON.parse(line) as TraceRecord);
      } catch {
        // 半行（并发写入被打断）直接丢弃。
      }
    }
    return records;
  } catch {
    return [];
  }
}
