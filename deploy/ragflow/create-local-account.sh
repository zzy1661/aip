#!/usr/bin/env bash
#
# 在本地 RAGFlow 栈上创建一个开发账号，并签发一把 API Key。
#
# 用法：
#   RAGFLOW_ACCOUNT_PASSWORD='<本地口令>' ./create-local-account.sh
#
# 约束：
# - 账号口令只从环境变量读取，不进命令行历史之外的任何文件；
# - 签发出来的 API Key 写进同目录的 .api-key（已被仓库 .gitignore 忽略），不打印到终端；
# - 脚本不做任何删除性操作，可以重复执行（账号已存在时走登录分支）。
#
# RAGFlow 的账号口令在传输前用 RSA/PKCS1v1.5 加密（服务端 conf/private.pem 的公钥），
# 因此这里用容器内的 conf/public.pem 做加密，再 base64 编码。

set -euo pipefail

cd "$(dirname "$0")"

: "${RAGFLOW_ACCOUNT_PASSWORD:?请通过环境变量 RAGFLOW_ACCOUNT_PASSWORD 提供账号口令}"

BASE_URL="${RAGFLOW_BASE_URL:-http://127.0.0.1:19380}"
ACCOUNT_EMAIL="${RAGFLOW_ACCOUNT_EMAIL:-aip-dev@local.test}"
ACCOUNT_NICKNAME="${RAGFLOW_ACCOUNT_NICKNAME:-aip-dev}"
OUTPUT_FILE="${OUTPUT_FILE:-./.env.api-key}"

COMPOSE=(docker compose --env-file .env -f compose.yaml)

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

# 1. 取公钥。镜像里带的就是与 conf/private.pem 配对的那一把。
"${COMPOSE[@]}" exec -T ragflow cat /ragflow/conf/public.pem > "${tmp_dir}/public.pem"
if [ ! -s "${tmp_dir}/public.pem" ]; then
  echo "取不到 /ragflow/conf/public.pem，请确认栈已启动。" >&2
  exit 1
fi

# 2. 用 RSA PKCS1v1.5 加密口令并 base64 编码。
printf '%s' "${RAGFLOW_ACCOUNT_PASSWORD}" \
  | openssl pkeyutl -encrypt -pubin -inkey "${tmp_dir}/public.pem" \
      -pkeyopt rsa_padding_mode:pkcs1 \
  | base64 > "${tmp_dir}/password.b64"
encrypted_password="$(cat "${tmp_dir}/password.b64")"

# 3. 注册。已注册过就退回登录。
register_body="$(printf '{"email":"%s","nickname":"%s","password":"%s"}' \
  "${ACCOUNT_EMAIL}" "${ACCOUNT_NICKNAME}" "${encrypted_password}")"

register_response="$(curl -sS -c "${tmp_dir}/cookies.txt" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/v1/user/register" \
  -d "${register_body}")"

if printf '%s' "${register_response}" | grep -q '"code":0'; then
  echo "账号 ${ACCOUNT_EMAIL} 创建成功。"
else
  echo "注册未成功（可能已存在），改用登录。"
  login_body="$(printf '{"email":"%s","password":"%s"}' \
    "${ACCOUNT_EMAIL}" "${encrypted_password}")"
  login_response="$(curl -sS -c "${tmp_dir}/cookies.txt" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/v1/user/login" \
    -d "${login_body}")"
  if ! printf '%s' "${login_response}" | grep -q '"code":0'; then
    echo "登录失败：$(printf '%s' "${login_response}" | head -c 300)" >&2
    exit 1
  fi
  echo "账号 ${ACCOUNT_EMAIL} 登录成功。"
fi

# 4. 签发 API Key。会话由 cookie 维持。
token_response="$(curl -sS -b "${tmp_dir}/cookies.txt" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/v1/system/new_token")"

api_key="$(printf '%s' "${token_response}" \
  | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)"

if [ -z "${api_key}" ]; then
  echo "签发 API Key 失败：$(printf '%s' "${token_response}" | head -c 300)" >&2
  exit 1
fi

umask 077
printf 'RAGFLOW_API_KEY=%s\n' "${api_key}" > "${OUTPUT_FILE}"

echo "API Key 已写入 ${OUTPUT_FILE}（未提交到版本库）。"
echo "取用方式：set -a; . ${OUTPUT_FILE}; set +a"
