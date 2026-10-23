import { apiError } from '../http/errors.js';

/**
 * 上游 RetCode.PERMISSION_ERROR。
 *
 * v0.20.5 的「按名称列数据集」在零命中时也返回该码（消息形如
 * `User '<tenant>' lacks permission for dataset '<name>'`），
 * 详见 docs/ragflow-lock.md §1.1。
 */
export const RAGFLOW_PERMISSION_ERROR = 108;

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

/** 上游不可达或超时。 */
export class RagFlowUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly timedOut: boolean,
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
