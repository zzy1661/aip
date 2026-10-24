import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, release } from 'node:os';
import { join, relative } from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';
import {
  dependencyLockHash,
  gitState,
  migrationDigests,
  readTraceRecords,
  repoRoot,
  reportDir,
  resetTraceRecords,
  sha256Of,
  type TraceRecord,
} from './context.js';

export interface ReporterOptions {
  /** 运行模式：unit / db / contract / e2e / real。 */
  mode: string;
}

type CaseStatus = 'PASS' | 'FAIL' | 'NOT RUN';

/** 把绝对路径转成仓库相对路径；虚拟模块 id 保持原样。 */
function toRepoRelative(moduleId: string): string {
  if (!moduleId.startsWith(repoRoot)) return moduleId;
  return relative(repoRoot, moduleId);
}

interface CaseRecord {
  case: string;
  file: string;
  mode: string;
  status: CaseStatus;
  duration_ms: number | null;
  assertion_count: number | null;
  subject_role: string[];
  trace_ids: string[];
  sample_hash: string | null;
  sample_hash_basis: 'requests' | 'test_file' | null;
  failure_reason: string | null;
}

/**
 * 验收报告写出器。
 *
 * 产物落在 reports/<git-sha>/<mode>/：cases.json 是逐用例记录，
 * summary.json 是本次运行的元数据与环境（对齐 ZACH-8 验收矩阵 §4 的字段）。
 */
export default class AcceptanceReportReporter implements Reporter {
  private readonly cases: CaseRecord[] = [];
  private readonly mode: string;

  constructor(options: ReporterOptions) {
    this.mode = options.mode;
  }

  onInit(): void {
    resetTraceRecords(this.mode);
  }

  onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const status: CaseStatus =
      result.state === 'passed' ? 'PASS' : result.state === 'failed' ? 'FAIL' : 'NOT RUN';
    const errors = 'errors' in result ? result.errors : undefined;
    const failureReason =
      status === 'FAIL'
        ? (errors && errors.length > 0
            ? String(errors[0]?.message ?? 'unknown failure')
            : 'unknown failure')
        : null;
    this.cases.push({
      case: testCase.fullName,
      file: toRepoRelative(testCase.module.moduleId),
      mode: this.mode,
      status,
      duration_ms: null,
      assertion_count: null,
      subject_role: [],
      trace_ids: [],
      sample_hash: null,
      sample_hash_basis: null,
      failure_reason: failureReason,
    });
  }

  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<unknown>,
    reason: string,
  ): Promise<void> {
    try {
      this.mergeRuntimeFacts();
      await this.write(testModules.length, unhandledErrors.length, reason);
    } catch {
      // 报告写出失败不能让测试进程失败：结论由用例本身决定。
    }
  }

  /**
   * 把运行期记录合并进用例记录。
   *
   * 断言计数与主体角色、trace_id 都来自 worker 侧（用例所在进程），
   * reporter 在主进程收不到这些信息，只能靠用例名与文件路径对齐。
   */
  private mergeRuntimeFacts(): void {
    const records = readTraceRecords(this.mode);
    const caseRecords = records.filter((record) => record.kind === 'case');
    const requestRecords = records.filter((record) => record.kind === 'request');

    for (const entry of this.cases) {
      const matched = caseRecords.find(
        (record) =>
          record.case === entry.case ||
          (typeof record.test_path === 'string' &&
            entry.file.endsWith(record.test_path.replace(/^.*?(tests\/)/, '$1')) &&
            typeof record.case === 'string' &&
            entry.case.endsWith(record.case)),
      );
      if (matched && typeof matched.assertion_count === 'number') {
        entry.assertion_count = matched.assertion_count;
      }

      const requests = requestRecords.filter(
        (record) => typeof record.case === 'string' && entry.case.endsWith(record.case),
      );
      const roles = new Set<string>();
      const traceIds = new Set<string>();
      const samples: string[] = [];
      for (const request of requests) {
        if (typeof request.subject_role === 'string') roles.add(request.subject_role);
        if (typeof request.trace_id === 'string' && request.trace_id.length > 0) {
          traceIds.add(request.trace_id);
        }
        if (typeof request.sample_hash === 'string') samples.push(request.sample_hash);
      }
      entry.subject_role = [...roles].sort();
      entry.trace_ids = [...traceIds].sort();
      if (samples.length > 0) {
        entry.sample_hash = sha256Of(samples.join('|'));
        entry.sample_hash_basis = 'requests';
      } else {
        entry.sample_hash = null;
        entry.sample_hash_basis = null;
      }
    }
  }

  private async write(
    moduleCount: number,
    unhandledErrorCount: number,
    reason: string,
  ): Promise<void> {
    const dir = reportDir(this.mode);
    mkdirSync(dir, { recursive: true });

    const state = gitState();
    const migrations = migrationDigests();
    const cases = this.cases.map((entry) => ({ ...entry }));

    const summary = {
      mode: this.mode,
      generated_at: new Date().toISOString(),
      commit: state.sha,
      dirty: state.dirty,
      changed_tracked: state.changed_tracked,
      untracked: state.untracked,
      dependency_lock_hash: dependencyLockHash(),
      migration: migrations,
      migration_set_hash: sha256Of(migrations.map((m) => `${m.file}:${m.sha256}`).join('\n')),
      ragflow: {
        // 非 real 层使用仓库内置替身：不存在真实上游 tag/digest。
        tag: this.mode === 'real' ? (process.env.RAGFLOW_SOURCE_SHA ?? null) : 'mock',
        source_sha: this.mode === 'real' ? (process.env.RAGFLOW_SOURCE_SHA ?? null) : 'mock',
        image_digest: this.mode === 'real' ? (process.env.RAGFLOW_IMAGE_DIGEST ?? null) : 'mock',
      },
      embedding_revision:
        this.mode === 'real' ? (process.env.RAGFLOW_EMBEDDING_REVISION ?? null) : 'test-embedding-revision',
      parser_digest: this.mode === 'real' ? (process.env.RAGFLOW_SOURCE_SHA ?? null) : 'test-parser-sha',
      deploy_env: {
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu_model: cpus()[0]?.model ?? 'unknown',
        cpu_count: cpus().length,
        node: process.version,
        ci: process.env.CI ?? null,
      },
      counts: {
        modules: moduleCount,
        cases: cases.length,
        pass: cases.filter((entry) => entry.status === 'PASS').length,
        fail: cases.filter((entry) => entry.status === 'FAIL').length,
        not_run: cases.filter((entry) => entry.status === 'NOT RUN').length,
      },
      unhandled_errors: unhandledErrorCount,
      run_end_reason: reason,
      hash_definitions: {
        dependency_lock_hash: 'sha256(pnpm-lock.yaml)',
        migration_set_hash: 'sha256(迁移文件名与内容哈希的拼接)',
        sample_hash: 'sha256(该用例内所有请求样例哈希的拼接)；无请求的用例记为 null',
        subject_role: '主体标识与权限派生角色，形如 <subject>/<role>',
      },
    };

    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    writeFileSync(join(dir, 'cases.json'), `${JSON.stringify({ mode: this.mode, cases }, null, 2)}\n`, 'utf8');
  }
}
