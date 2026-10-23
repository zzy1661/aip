-- 008_index_rebuild.sql — 索引重建：同一上游文档允许存在多份索引修订映射。

-- 旧约束让一个上游文档只能对应一条映射，索引重建无法落第二份索引修订，
-- 重建后只能覆盖旧映射，旧 evidence 引用的索引修订就失效了。
ALTER TABLE knowledge_index_map
  DROP CONSTRAINT IF EXISTS knowledge_index_map_scope_id_dataset_id_document_id_key;

-- 检索只使用最新索引修订，旧映射保留以便旧 evidence 继续解析。
CREATE INDEX IF NOT EXISTS knowledge_index_map_document_revision_idx
  ON knowledge_index_map (scope_id, document_id, index_revision);
