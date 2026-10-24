/**
 * 审核结论的状态机（ZACH-17 裁决 a）。
 *
 * 已批准是终态：一个版本的 approved 结论一旦落库就不能再被改判，
 * 否则同一个版本在检索（按 approved 过滤）与下载（不按审核结论过滤）两条路径上
 * 会被解释成两种结果——检索查不到、下载照发正文。
 *
 * 三种处理方式：
 * - `apply`     正常落库：写审核记录、推进 state_revision。
 * - `idempotent` 同结论重放：不写任何行，返回当前已生效的审核事实。
 * - `forbidden` 改判已批准的版本：拒绝，且不产生任何写入。
 */

/** 审核结论的取值（与 contracts 的请求契约一致）。 */
export type ReviewDecision = 'approved' | 'rejected';

/** 审核结论在库里的取值（数据库 CHECK 约束限定为这三个）。 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

/** 一次审核请求的处理方式。 */
export type ReviewOutcome = 'apply' | 'idempotent' | 'forbidden';

/**
 * 判定一次审核请求的处理方式。
 *
 * @param current 当前已落库的审核结论（pending / approved / rejected）。
 * @param decision 本次请求的结论。
 */
export function classifyReview(current: string, decision: ReviewDecision): ReviewOutcome {
  if (current !== 'approved') return 'apply';
  return decision === 'approved' ? 'idempotent' : 'forbidden';
}
