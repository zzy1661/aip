import { apiError, fieldIssue } from '../http/errors.js';

export interface ConceptReference {
  concept_ref: string;
  unit_ref: string | null;
  ontology_version: string | null;
  vocabulary_version: string | null;
}

export type ConceptValidationOutcome =
  | { ok: true }
  | { ok: false; reason: string; field_path: string };

export interface ConceptValidator {
  /** 返回 false 表示本体服务不可用；此时不得把校验降级为通过。 */
  validate(refs: ConceptReference[]): Promise<ConceptValidationOutcome>;
}

export interface OntoClientOptions {
  baseUrl: string | null;
  audience: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 本体概念精确验证门。
 *
 * 端点形态 `{base}/api/ontology/concepts/{concept_ref}` 是本批的假设契约：
 * 本体 API 的最终形态由 ZACH-4 / 后续 E1 冻结，此处只保证「不可用即拒绝」，
 * 不会把失败伪装成验证通过。
 */
export function createOntoConceptValidator(options: OntoClientOptions): ConceptValidator {
  const timeoutMs = options.timeoutMs ?? 5000;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async validate(refs: ConceptReference[]): Promise<ConceptValidationOutcome> {
      if (!options.baseUrl) {
        return {
          ok: false,
          reason: 'ontology service is not configured for this deployment',
          field_path: 'payload',
        };
      }
      for (const ref of refs) {
        const url = new URL(
          `/api/ontology/concepts/${encodeURIComponent(ref.concept_ref)}`,
          options.baseUrl,
        );
        if (ref.ontology_version) url.searchParams.set('ontology_version', ref.ontology_version);
        if (ref.vocabulary_version) {
          url.searchParams.set('vocabulary_version', ref.vocabulary_version);
        }
        if (ref.unit_ref) url.searchParams.set('unit_ref', ref.unit_ref);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await doFetch(url, {
            signal: controller.signal,
            headers: options.audience ? { 'x-audience': options.audience } : {},
          });
        } catch {
          throw apiError('ONTO_UNAVAILABLE', 'ontology service is unreachable');
        } finally {
          clearTimeout(timer);
        }

        if (response.status === 404) {
          return {
            ok: false,
            reason: `concept reference does not exist: ${ref.concept_ref}`,
            field_path: 'payload',
          };
        }
        if (response.status === 401 || response.status === 403) {
          throw apiError('ONTO_UNAVAILABLE', 'ontology service rejected the platform credential');
        }
        if (!response.ok) {
          throw apiError('ONTO_UNAVAILABLE', `ontology service returned ${response.status}`);
        }
      }
      return { ok: true };
    },
  };
}

export function toFieldIssueList(
  outcome: Extract<ConceptValidationOutcome, { ok: false }>,
): Array<{ field_path: string; reason: string }> {
  return [fieldIssue(outcome.field_path, outcome.reason)];
}
