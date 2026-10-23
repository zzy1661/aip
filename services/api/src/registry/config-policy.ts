/**
 * Agent config 的键值准入策略。
 *
 * 两条要求必须同时成立：
 * - 合法配置不能被误杀：`max_tokens`、`redirect`、`command_timeout` 这类普通参数必须放行；
 * - 密钥与出网入口不能落库：承载密钥的键名、密钥形似值、地址形似值一律拒绝。
 *
 * 匹配一律按「整词」而不是子串进行：`monkey` 不是密钥，`private_key` 才是。
 */

/** 明确放行的键：键名含有被禁词，但语义是普通参数而不是密钥或能力入口。 */
const ALLOWED_CONFIG_KEYS = new Set([
  'max_tokens',
  'max_output_tokens',
  'token_budget',
  'tokens_per_minute',
  'redirect',
  'redirect_url',
  'webhook_url',
  'callback_url',
  'command_timeout',
  'command_max_output',
  'execution_policy',
  'execution_timeout',
]);

/** 承载密钥的整词键名片段。 */
const SECRET_KEY_WORDS = new Set([
  'secret',
  'secrets',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'authorization',
  'bearer',
  'jwt',
  'cookie',
  'token',
  'tokens',
  'auth',
]);

/**
 * 承载密钥的整词键名组合。
 *
 * `private_key`、`session_key` 这类键的单词本身都不是密钥词，
 * 只有组合起来才是，必须单独列出。
 */
const SECRET_KEY_PHRASES = [
  'api_key',
  'apikey',
  'access_key',
  'accesskey',
  'private_key',
  'privatekey',
  'signing_key',
  'signingkey',
  'encryption_key',
  'encryptionkey',
  'session_key',
  'sessionkey',
  'client_key',
  'clientkey',
  'master_key',
  'masterkey',
  'app_key',
  'appkey',
  'key_pair',
  'keypair',
];

/** 承载出网或执行能力的整词键名片段。 */
const CAPABILITY_KEY_WORDS = new Set([
  'endpoint',
  'command',
  'cmd',
  'exec',
  'plugin',
  'script',
  'hook',
  'path',
  'dir',
]);

/** 形似出网地址的值。config 本批次不参与出网，地址一律不落库。 */
const ADDRESS_LIKE_VALUE = [
  /^[a-z][a-z0-9+.-]*:/i,
  /^\/\//,
  /^[a-z0-9-]+(\.[a-z]{2,6}){1,}(:\d+)?([/?#].*)?$/i,
];

/** 形似密钥的值。 */
const SECRET_LIKE_VALUE = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|gho|ghu|ghs|github_pat|xoxb|xoxp|xoxa|glpat|akia|asia)[-_][A-Za-z0-9]{10,}/i,
  /^(?:bearer|basic)\s+\S+/i,
];

/** 驼峰转下划线：`privateKey` 与 `private_key` 必须是同一个键。 */
function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.]+/g, '_')
    .toLowerCase();
}

function words(snake: string): string[] {
  return snake.split('_').filter((word) => word.length > 0);
}

/** 该键是否承载密钥或出网/执行能力。 */
export function isForbiddenConfigKey(key: string): boolean {
  const snake = toSnakeCase(key);
  if (ALLOWED_CONFIG_KEYS.has(snake)) return false;
  const parts = words(snake);
  if (parts.some((word) => SECRET_KEY_WORDS.has(word))) return true;
  if (parts.some((word) => CAPABILITY_KEY_WORDS.has(word))) return true;
  return SECRET_KEY_PHRASES.some((phrase) => snake.includes(phrase));
}

/** 该键是否承载密钥（用于详情接口脱敏，不含能力类键）。 */
export function isSecretConfigKey(key: string): boolean {
  const snake = toSnakeCase(key);
  if (ALLOWED_CONFIG_KEYS.has(snake)) return false;
  const parts = words(snake);
  if (parts.some((word) => SECRET_KEY_WORDS.has(word))) return true;
  return SECRET_KEY_PHRASES.some((phrase) => snake.includes(phrase));
}

/** 长 base64 块：看起来像随机密钥，但不是十六进制摘要。 */
function looksLikeHighEntropyBlob(value: string): boolean {
  if (value.length < 40) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  if (/^[0-9a-f]+$/i.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(value)).length;
  return classes >= 2;
}

/** 该值是否形似出网地址。 */
export function isAddressLikeValue(value: string): boolean {
  const trimmed = value.trim();
  return ADDRESS_LIKE_VALUE.some((pattern) => pattern.test(trimmed));
}

/** 该值是否形似密钥。 */
export function isSecretLikeValue(value: string): boolean {
  if (SECRET_LIKE_VALUE.some((pattern) => pattern.test(value))) return true;
  return looksLikeHighEntropyBlob(value.trim());
}

/**
 * 详情接口的兜底脱敏。
 *
 * 写入路径已经拒绝承载密钥的键与密钥形似值，这里只是防止绕过写入路径
 * （例如直接写库）之后，密钥被原样读回。
 */
export function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValues(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretConfigKey(key)) {
      result[key] = '[REDACTED]';
      continue;
    }
    result[key] = redactSecretValues(entry);
  }
  return result;
}
