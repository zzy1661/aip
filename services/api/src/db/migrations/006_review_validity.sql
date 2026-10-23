-- 006_review_validity.sql — 审核有效期、适用条件显式化。
--
-- 只做向前兼容的增量变更：不改写既有列语义，不删除任何数据。
-- 约束使用 NOT VALID，只约束新写入的行，避免历史数据在迁移瞬间阻塞发布。

ALTER TABLE knowledge_review
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

ALTER TABLE knowledge_review
  ADD CONSTRAINT knowledge_review_validity_check
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from) NOT VALID;

-- knowledge_revision 上的有效期是当前审核结论的有效区间，与审核记录同事务写入，
-- 供检索路径直接过滤，避免为「最新一次审核」引入排序歧义。
ALTER TABLE knowledge_revision
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

ALTER TABLE knowledge_revision
  ADD CONSTRAINT knowledge_revision_validity_check
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from) NOT VALID;

-- 适用条件必须显式声明模式：真实业务不得用空对象冒充「通用」。
ALTER TABLE knowledge_revision
  ADD CONSTRAINT knowledge_revision_applies_to_check
  CHECK (
    applies_to ? 'mode'
    AND applies_to ->> 'mode' IN ('unconditional', 'conditional')
  ) NOT VALID;

-- 新写入行不再使用空对象默认值；既有空对象行的语义原本就是「无适用条件」，
-- 回填为 unconditional 只是把既有语义显式化，不改变可见范围。
ALTER TABLE knowledge_revision
  ALTER COLUMN applies_to SET DEFAULT '{"mode":"unconditional"}'::jsonb;

UPDATE knowledge_revision
   SET applies_to = '{"mode":"unconditional"}'::jsonb
 WHERE applies_to = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS knowledge_revision_validity_idx
  ON knowledge_revision (scope_id, review_status, valid_from, valid_until);
