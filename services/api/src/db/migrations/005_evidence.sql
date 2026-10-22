-- 005_evidence.sql — 检索命中证据快照，引用索引修订与来源文件版本。

CREATE TABLE evidence (
  scope_id            text             NOT NULL,
  id                  uuid             NOT NULL,
  knowledge_ref       uuid             NOT NULL,
  knowledge_version   text             NOT NULL,
  index_revision      uuid             NOT NULL,
  source_file_revision uuid            NOT NULL,
  chunk_id            text             NOT NULL,
  chunk_hash          text             NOT NULL,
  locator             jsonb            NOT NULL DEFAULT '{}'::jsonb,
  content             text             NOT NULL,
  content_digest      text             NOT NULL,
  score               double precision NOT NULL,
  authz_revision      bigint           NOT NULL,
  created_at          timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id),
  FOREIGN KEY (scope_id, index_revision)
    REFERENCES index_revision (scope_id, id),
  FOREIGN KEY (scope_id, knowledge_ref, knowledge_version)
    REFERENCES knowledge_revision (scope_id, knowledge_id, version)
);

CREATE INDEX evidence_knowledge_idx
  ON evidence (scope_id, knowledge_ref, knowledge_version);
