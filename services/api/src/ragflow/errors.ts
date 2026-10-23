import { apiError } from '../http/errors.js';

/** 上游业务失败：HTTP 成功但 code 非 0。 */
export class RagFlowBusinessError extends Error {
  constructor(
    readonly upstreamCode: number,
    readonly sanitizedMessage: string,
  ) {
    super(`ragflow business failure code=${upstreamCode}`);
    this.name = 'RagFlowBusinessError';
  }
}

/** 上游响应结构不符合固定契约。 */
export class RagFlowProtocolError extends Error {
  constructor(reason: string) {
    super(`ragflow protocol error: ${reason}`);
    this.name = 'RagFlowProtocolError';
  }
}

/**
 * 上游不可达或超时。
 *
 * 分类必须区分「请求有没有送达上游」：
 * - not_delivered：请求确定没有送达（DNS 失败、连接被拒、连接阶段超时）。可以安全重试。
 * - delivered_unknown：请求可能已被上游接收，但响应没有回来（读超时、连接中断）。
 *   写操作在此状态下禁止盲重发，否则会造出重复的远端对象。
 * - credential_rejected：上游明确拒绝了平台凭据，重试没有意义。
 * - upstream_unavailable：上游返回了 5xx，是可重试的瞬时故障。
 */
export type RagFlowFailureKind =
  | 'not_delivered'
  | 'delivered_unknown'
  | 'credential_rejected'
  | 'upstream_unavailable';

export class RagFlowUnavailableError extends Error {
  /**
   * 是否发生在写请求上。
   *
   * 只有写请求才需要它：写请求「送达但结果未知」时必须禁止重发，
   * 只读请求的同类故障可以安全重试。
   */
  writeAttempt = false;

  constructor(
    readonly reason: string,
    readonly kind: RagFlowFailureKind,
    readonly timedOut = false,
  ) {
    super(`ragflow unavailable: ${reason}`);
    this.name = 'RagFlowUnavailableError';
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function sanitizeUpstreamMessage(message: unknown): string {
  if (typeof message !== 'string') return '';
  return message.replace(CONTROL_CHARS, ' ').slice(0, 200);
}

export function toApiError(error: unknown): Error {
  if (error instanceof RagFlowProtocolError) {
    return apiError('RAGFLOW_PROTOCOL_ERROR', 'ragflow response did not match the fixed contract');
  }
  if (error instanceof RagFlowBusinessError) {
    return apiError('RAGFLOW_PROTOCOL_ERROR', 'ragflow rejected the request');
  }
  if (error instanceof RagFlowUnavailableError) {
    return apiError(
      error.timedOut ? 'RAGFLOW_TIMEOUT' : 'RAGFLOW_UNAVAILABLE',
      'ragflow is unreachable',
    );
  }
  return error as Error;
}
