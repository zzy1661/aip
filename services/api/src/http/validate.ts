import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { apiError, fieldIssue } from './errors.js';
import type { FieldIssue } from '@aip/contracts';

export type SchemaLike = Record<string, unknown>;

// ajv-formats 以 CommonJS 发布，默认导入的类型是模块命名空间，这里还原成可调用插件。
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export class Validator {
  private readonly ajv: Ajv;
  private readonly cache = new Map<SchemaLike, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
    addFormats(this.ajv);
  }

  private compile(schema: SchemaLike): ValidateFunction {
    const cached = this.cache.get(schema);
    if (cached) return cached;
    const validate = this.ajv.compile(schema);
    this.cache.set(schema, validate);
    return validate;
  }

  /** 校验失败时抛出 422 CONTRACT_INVALID，并把错误定位到字段路径。 */
  assert<T>(schema: SchemaLike, value: unknown, basePath = ''): T {
    const validate = this.compile(schema);
    if (validate(value)) return value as T;
    const issues = toFieldIssues(validate.errors ?? [], basePath);
    throw apiError('CONTRACT_INVALID', 'request failed contract validation', issues);
  }
}

export function toFieldIssues(errors: ErrorObject[], basePath: string): FieldIssue[] {
  return errors.map((error) => {
    const path = error.instancePath
      .split('/')
      .filter((part) => part.length > 0)
      .map((part, index) => (/^\d+$/.test(part) ? `[${part}]` : index === 0 ? part : `.${part}`))
      .join('')
      .replace(/\]\./g, '].');
    const fullPath = [basePath, path].filter((part) => part.length > 0).join('.');
    return fieldIssue(fullPath || 'body', error.message ?? 'invalid value');
  });
}
