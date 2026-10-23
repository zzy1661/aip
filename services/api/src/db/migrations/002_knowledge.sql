-- 002_knowledge.sql — 知识库、来源文件版本、知识版本与索引映射。

CREATE TABLE knowledge_base (
  scope_id            text        NOT NULL,
  id                  uuid        NOT NULL,
  name                text        NOT NULL,
  description         text        NOT NULL DEFAULT '',
  status              text        NOT NULL DEFAULT 'creating',
  ragflow_dataset_id  text,
  operation_id        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id),
  UNIQUE (scope_id, ragflow_dataset_id),
  CONSTRAINT knowledge_base_status_check
    CHECK (status IN ('creating', 'ready', 'failed', 'unknown_outcome'))
);

CREATE TABLE source_file_revision (
  scope_id     text        NOT NULL,
  id           uuid        NOT NULL,
  version      text        NOT NULL,
  name         text        NOT NULL,
  mime         text        NOT NULL,
  size         bigint      NOT NULL,
  sha256       text        NOT NULL,
  storage_key  text        NOT NULL,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id, version),
  UNIQUE (scope_id, storage_key)
);

CREATE TABLE knowledge_revision (
  scope_id             text        NOT NULL,
  knowledge_id         uuid        NOT NULL,
  version              text        NOT NULL,
  kb_id                uuid        NOT NULL,
  source_file_id       uuid        NOT NULL,
  source_file_version  text        NOT NULL,
  review_status        text        NOT NULL DEFAULT 'pending',
  status               text        NOT NULL DEFAULT 'uploaded',
  state_revision       integer     NOT NULL DEFAULT 1,
  applies_to           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  content_hash         text        NOT NULL,
  created_by           text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, knowledge_id, version),
  FOREIGN KEY (scope_id, kb_id)
    REFERENCES knowledge_base (scope_id, id),
  FOREIGN KEY (scope_id, source_file_id, source_file_version)
    REFERENCES source_file_revision (scope_id, id, version),
  CONSTRAINT knowledge_revision_review_check
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT knowledge_revision_status_check
    CHECK (status IN ('uploaded', 'parse_queued', 'parsing', 'ready', 'empty',
                      'failed', 'unknown_outcome', 'withdrawn'))
);

CREATE INDEX knowledge_revision_scope_status_idx
  ON knowledge_revision (scope_id, status, review_status);

-- 审核记录独立成表：审核人、期望哈希、理由、时间都真实落库。
CREATE TABLE knowledge_review (
  scope_id      text        NOT NULL,
  knowledge_id  uuid        NOT NULL,
  version       text        NOT NULL,
  decision      text        NOT NULL,
  reviewer      text        NOT NULL,
  expected_hash text        NOT NULL,
  reason        text        NOT NULL,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, knowledge_id, version, reviewed_at),
  FOREIGN KEY (scope_id, knowledge_id, version)
    REFERENCES knowledge_revision (scope_id, knowledge_id, version),
  CONSTRAINT knowledge_review_decision_check CHECK (decision IN ('approved', 'rejected'))
);

CREATE TABLE index_revision (
  scope_id           text        NOT NULL,
  id                 uuid        NOT NULL,
  knowledge_id       uuid        NOT NULL,
  knowledge_version  text        NOT NULL,
  parser_hash        text        NOT NULL,
  embedding_revision text        NOT NULL,
  status             text        NOT NULL,
  chunk_count        integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id),
  FOREIGN KEY (scope_id, knowledge_id, knowledge_version)
    REFERENCES knowledge_revision (scope_id, knowledge_id, version)
);

CREATE TABLE knowledge_index_map (
  scope_id       text   NOT NULL,
  index_revision uuid   NOT NULL,
  kb_id          uuid   NOT NULL,
  dataset_id     text   NOT NULL,
  document_id    text   NOT NULL,
  PRIMARY KEY (scope_id, index_revision, dataset_id, document_id),
  FOREIGN KEY (scope_id, index_revision)
    REFERENCES index_revision (scope_id, id),
  FOREIGN KEY (scope_id, kb_id)
    REFERENCES knowledge_base (scope_id, id),
  UNIQUE (scope_id, dataset_id, document_id)
);

CREATE INDEX knowledge_index_map_document_idx
  ON knowledge_index_map (scope_id, document_id);
