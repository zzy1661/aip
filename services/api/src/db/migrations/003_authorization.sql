-- 003_authorization.sql — 主体权限、文档级授权、授权版本与本地拒绝名单。

CREATE TABLE principal_grant (
  scope_id   text NOT NULL,
  subject    text NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (scope_id, subject, permission)
);

CREATE TABLE document_grant (
  scope_id         text    NOT NULL,
  knowledge_id     uuid    NOT NULL,
  knowledge_version text   NOT NULL,
  subject          text    NOT NULL,
  can_read         boolean NOT NULL DEFAULT false,
  can_download     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (scope_id, knowledge_id, knowledge_version, subject),
  FOREIGN KEY (scope_id, knowledge_id, knowledge_version)
    REFERENCES knowledge_revision (scope_id, knowledge_id, version)
);

CREATE INDEX document_grant_subject_idx
  ON document_grant (scope_id, subject, can_read);

-- 授权版本：吊销事务递增该值，响应交付前据此复核末次授权。
CREATE TABLE authz_state (
  scope_id text   NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_id)
);

CREATE TABLE local_deny (
  scope_id text NOT NULL,
  subject  text NOT NULL,
  PRIMARY KEY (scope_id, subject)
);
