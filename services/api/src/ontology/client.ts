import { apiError, fieldIssue } from '../http/errors.js';
import type { DataType } from '@aip/contracts';

/**
 * The concept query contract, frozen in
 * `docs/ontology-concept-query-contract.md` and shared with onto.
 *
 * The endpoint, the reference shape, the response fields, the error codes and
 * the check order are all defined there; this file is aip's side of it.
 * The two repos also share one fixture
 * (`tests/fixtures/onto-concept-query.v1.json`) that both sides assert
 * against, so a change on one side fails a test on the other.
 */

/** The contract version this client implements; it must equal onto's. */
export const CONCEPT_QUERY_CONTRACT_VERSION = 'onto-concept-query/v1';

/**
 * Which onto data types satisfy which declared type.
 *
 * The two platforms do not share a vocabulary -- aip says `NUMBER`, onto says
 * `INTEGER`/`DECIMAL` -- so a contract field that declares `NUMBER` and points
 * at a `STRING` concept is a mistake in the registration, not a fact about the
 * ontology. Letting it through would write a semantic error into the registry.
 *
 * Frozen by §8 of the contract.
 */
export const CONCEPT_TYPE_COMPATIBILITY: Record<DataType, readonly string[]> = {
  NUMBER: ['INTEGER', 'DECIMAL'],
  STRING: ['STRING', 'TEXT', 'ENUM', 'DATE', 'DATETIME'],
  BOOLEAN: ['BOOLEAN'],
  JSON: [],
};

export interface ConceptReference {
  concept_ref: string;
  /** The type the contract field declares; it must match the concept's type. */
  data_type: DataType;
  unit_ref: string | null;
  ontology_version: string | null;
  vocabulary_version: string | null;
}

export type ConceptValidationOutcome =
  | { ok: true }
  | { ok: false; reason: string; field_path: string; concept_ref?: string };

export interface ConceptValidator {
  /** 返回 false 表示本体服务不可用；此时不得把校验降级为通过。 */
  validate(refs: ConceptReference[]): Promise<ConceptValidationOutcome>;
}

export interface OntoClientOptions {
  baseUrl: string | null;
  audience: string | null;
  /** 单次概念查询的超时。 */
  timeoutMs?: number;
  /** 一批引用整体的时间预算：引用条数不设上限，没有总预算会线性放大等待。 */
  totalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The failure codes the contract defines for a rejected reference. */
const REJECTING_STATUSES = new Set([400, 404, 409, 422]);

/** The part of a `concept_ref` before the colon: the ontology code. */
function ontologyCodeOf(conceptRef: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9_]*):/.exec(conceptRef);
  return m ? m[1]! : null;
}

/** The part of a `concept_ref` after the colon: the property code. */
function propertyCodeOf(conceptRef: string): string | null {
  const m = /^[A-Za-z][A-Za-z0-9_]*:([A-Za-z][A-Za-z0-9_]*)$/.exec(conceptRef);
  return m ? m[1]! : null;
}

/**
 * The unit symbol a reference names.
 *
 * The contract allows `<symbol>` and `<namespace>:unit:<symbol>`; the symbol is
 * the last segment in both cases.
 */
function unitSymbolOf(unitRef: string): string {
  const parts = unitRef.split(':');
  return parts[parts.length - 1]!;
}

/**
 * The ontology concept gate.
 *
 * Every reference is checked against onto, one by one, and the first failure
 * ends the batch: a batch of references is one contract, and a contract that is
 * half-checked is not a checked contract.
 *
 * The rule that matters most here: **a failure is never a pass**. An ontology
 * service that is unreachable, that answers with something this client does not
 * understand, or that rejects a reference, all end in a refusal -- never in
 * "validated".
 */
export function createOntoConceptValidator(options: OntoClientOptions): ConceptValidator {
  const timeoutMs = options.timeoutMs ?? 5000;
  const totalTimeoutMs = options.totalTimeoutMs ?? timeoutMs * 4;
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
      const deadline = Date.now() + totalTimeoutMs;
      for (const ref of refs) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw apiError('ONTO_UNAVAILABLE', 'ontology validation budget exhausted');
        }
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
        const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
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

        const body = await readBody(response);

        if (!response.ok) {
          if (REJECTING_STATUSES.has(response.status)) {
            return {
              ok: false,
              reason: rejectionReason(ref, response.status, body),
              field_path: 'payload',
              concept_ref: ref.concept_ref,
            };
          }
          throw apiError(
            'ONTO_UNAVAILABLE',
            `ontology service returned ${response.status}`,
          );
        }

        const problem = checkAgainstContract(ref, body);
        if (problem) {
          // The answer does not look like the contract this client implements.
          // That is a broken service, not a broken registration: refusing to
          // pass is the only safe reading, and the reason says which part of
          // the contract did not hold.
          throw apiError('ONTO_UNAVAILABLE', `ontology response does not match the contract: ${problem}`);
        }

        const mismatch = semanticMismatch(ref, body);
        if (mismatch) {
          return {
            ok: false,
            reason: mismatch,
            field_path: 'payload',
            concept_ref: ref.concept_ref,
          };
        }
      }
      return { ok: true };
    },
  };
}

/** The response body, or null when it is not JSON. */
async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why onto refused this reference, in words that name the reference. */
function rejectionReason(
  ref: ConceptReference,
  status: number,
  body: Record<string, unknown> | null,
): string {
  const errorCode = typeof body?.error_code === 'string' ? body.error_code : null;
  const message = typeof body?.message === 'string' ? body.message : '';
  const code = errorCode ? ` (${errorCode})` : '';
  const detail = message ? `: ${message}` : '';
  return `concept reference ${ref.concept_ref} was rejected by the ontology service${code}${detail}`;
}

/**
 * The structural checks: does the answer look like the contract at all?
 *
 * A renamed field, a missing field or a wrong contract version is a service
 * that is not the one this client was written for. It must not be read as
 * "the concept is fine" -- so this returns a reason and the caller refuses.
 */
function checkAgainstContract(
  ref: ConceptReference,
  body: Record<string, unknown> | null,
): string | null {
  if (!body) return 'the response body is not a JSON object';
  if (body.code !== 0) return `the response envelope reports code=${String(body.code)}`;
  const result = body.result;
  if (!result || typeof result !== 'object') return 'the response carries no result';
  const r = result as Record<string, unknown>;

  if (r.contract_version !== CONCEPT_QUERY_CONTRACT_VERSION) {
    return `contract_version is ${JSON.stringify(r.contract_version ?? null)}, expected ${CONCEPT_QUERY_CONTRACT_VERSION}`;
  }
  if (r.concept_ref !== ref.concept_ref) {
    return `concept_ref is ${JSON.stringify(r.concept_ref ?? null)}, expected ${JSON.stringify(ref.concept_ref)}`;
  }

  const ontology = r.ontology;
  if (!ontology || typeof ontology !== 'object') return 'the response carries no ontology block';
  const o = ontology as Record<string, unknown>;
  const expectedOntology = ontologyCodeOf(ref.concept_ref);
  if (expectedOntology !== null && o.code !== expectedOntology) {
    return `ontology.code is ${JSON.stringify(o.code ?? null)}, expected ${JSON.stringify(expectedOntology)}`;
  }
  if (typeof o.version !== 'number') return 'the response carries no ontology version';
  if (typeof o.published !== 'boolean') return 'the response does not say whether the ontology is published';

  const concept = r.concept;
  if (!concept || typeof concept !== 'object') return 'the response carries no concept block';
  const c = concept as Record<string, unknown>;
  const expectedProperty = propertyCodeOf(ref.concept_ref);
  if (expectedProperty !== null && c.code !== expectedProperty) {
    return `concept.code is ${JSON.stringify(c.code ?? null)}, expected ${JSON.stringify(expectedProperty)}`;
  }
  if (typeof c.data_type !== 'string') return 'the response carries no concept data_type';

  if (typeof r.vocabulary_version !== 'string') {
    return 'the response carries no vocabulary_version';
  }
  if (ref.unit_ref) {
    const unit = r.unit;
    if (!unit || typeof unit !== 'object') return 'the response carries no unit block';
    const u = unit as Record<string, unknown>;
    if (typeof u.unit !== 'string') return 'the response carries no unit symbol';
  }
  return null;
}

/**
 * The semantic checks: the concept exists, but does it say what the contract
 * field says?
 *
 * These are registration mistakes rather than service failures, so they are
 * reported as a refusal with the reference named, not as an outage.
 */
function semanticMismatch(ref: ConceptReference, body: Record<string, unknown> | null): string | null {
  const r = (body?.result ?? {}) as Record<string, unknown>;
  const o = (r.ontology ?? {}) as Record<string, unknown>;
  const c = (r.concept ?? {}) as Record<string, unknown>;

  if (o.published !== true) {
    return `concept reference ${ref.concept_ref} points at an ontology that is not published`;
  }
  if (ref.ontology_version && String(o.version) !== ref.ontology_version) {
    return `concept reference ${ref.concept_ref} is bound to ontology version ${ref.ontology_version}, but the ontology now serves version ${String(o.version)}`;
  }
  if (ref.vocabulary_version && r.vocabulary_version !== ref.vocabulary_version) {
    return `concept reference ${ref.concept_ref} is bound to vocabulary version ${ref.vocabulary_version}, but the ontology service serves ${String(r.vocabulary_version)}`;
  }
  if (ref.unit_ref) {
    const u = (r.unit ?? {}) as Record<string, unknown>;
    const expected = unitSymbolOf(ref.unit_ref);
    if (u.unit !== expected) {
      return `concept reference ${ref.concept_ref} declares unit ${ref.unit_ref}, but the ontology service resolved ${JSON.stringify(u.unit ?? null)}`;
    }
  }
  const allowed = CONCEPT_TYPE_COMPATIBILITY[ref.data_type] ?? [];
  const actual = String(c.data_type);
  if (!allowed.includes(actual)) {
    return `concept reference ${ref.concept_ref} declares type ${ref.data_type}, but the ontology concept is ${actual}`;
  }
  return null;
}

export function toFieldIssueList(
  outcome: Extract<ConceptValidationOutcome, { ok: false }>,
): Array<{ field_path: string; reason: string }> {
  return [fieldIssue(outcome.field_path, outcome.reason)];
}
