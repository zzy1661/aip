-- 001_registry.sql — Skill / Agent 资产注册与版本事实。

CREATE TABLE asset (
  scope_id   text        NOT NULL,
  id         uuid        NOT NULL,
  type       text        NOT NULL,
  slug       text        NOT NULL,
  owner      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id),
  UNIQUE (scope_id, type, slug),
  CONSTRAINT asset_type_check CHECK (type IN ('Skill', 'Agent'))
);

CREATE TABLE asset_revision (
  scope_id           text        NOT NULL,
  asset_id           uuid        NOT NULL,
  version            text        NOT NULL,
  title              text        NOT NULL,
  description        text        NOT NULL DEFAULT '',
  payload            jsonb       NOT NULL,
  content_hash       text        NOT NULL,
  schema_version     integer     NOT NULL DEFAULT 1,
  registration_status text       NOT NULL DEFAULT 'registered',
  created_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  state_revision     integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_id, asset_id, version),
  FOREIGN KEY (scope_id, asset_id) REFERENCES asset (scope_id, id),
  CONSTRAINT asset_revision_status_check
    CHECK (registration_status IN ('registered', 'deprecated', 'revoked')),
  CONSTRAINT asset_revision_version_check
    CHECK (version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
);

CREATE INDEX asset_revision_scope_type_idx
  ON asset_revision (scope_id, asset_id, version);

-- 版本内容不可覆盖：正文与哈希一旦写入不可变更。
CREATE OR REPLACE FUNCTION aip_asset_revision_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset_revision rows are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'asset_revision content columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- 注册状态只允许 registered -> deprecated -> revoked，且 revoked 不可恢复。
  IF NEW.registration_status IS DISTINCT FROM OLD.registration_status THEN
    IF NOT (
      (OLD.registration_status = 'registered' AND NEW.registration_status IN ('deprecated', 'revoked'))
      OR (OLD.registration_status = 'deprecated' AND NEW.registration_status = 'revoked')
    ) THEN
      RAISE EXCEPTION 'illegal registration_status transition % -> %',
        OLD.registration_status, NEW.registration_status USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state_revision <> OLD.state_revision + 1 THEN
      RAISE EXCEPTION 'state_revision must increment by one on status change'
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF NEW.state_revision <> OLD.state_revision THEN
    RAISE EXCEPTION 'state_revision may only change together with registration_status'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asset_revision_immutable_trigger
  BEFORE UPDATE OR DELETE ON asset_revision
  FOR EACH ROW EXECUTE FUNCTION aip_asset_revision_immutable();

CREATE TABLE agent_skill_binding (
  scope_id      text    NOT NULL,
  agent_id      uuid    NOT NULL,
  agent_version text    NOT NULL,
  skill_id      uuid    NOT NULL,
  skill_version text    NOT NULL,
  ordinal       integer NOT NULL,
  PRIMARY KEY (scope_id, agent_id, agent_version, skill_id, skill_version),
  FOREIGN KEY (scope_id, agent_id, agent_version)
    REFERENCES asset_revision (scope_id, asset_id, version),
  FOREIGN KEY (scope_id, skill_id, skill_version)
    REFERENCES asset_revision (scope_id, asset_id, version),
  UNIQUE (scope_id, agent_id, agent_version, ordinal)
);

-- 绑定两端必须是正确的资产类型，避免把 Agent 版本当作 Skill 绑定。
CREATE OR REPLACE FUNCTION aip_agent_skill_binding_types() RETURNS trigger AS $$
DECLARE
  agent_type text;
  skill_type text;
BEGIN
  SELECT a.type INTO agent_type
    FROM asset_revision r JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
   WHERE r.scope_id = NEW.scope_id AND r.asset_id = NEW.agent_id AND r.version = NEW.agent_version;
  SELECT a.type INTO skill_type
    FROM asset_revision r JOIN asset a ON a.scope_id = r.scope_id AND a.id = r.asset_id
   WHERE r.scope_id = NEW.scope_id AND r.asset_id = NEW.skill_id AND r.version = NEW.skill_version;
  IF agent_type IS DISTINCT FROM 'Agent' THEN
    RAISE EXCEPTION 'binding endpoint must reference an Agent revision' USING ERRCODE = 'restrict_violation';
  END IF;
  IF skill_type IS DISTINCT FROM 'Skill' THEN
    RAISE EXCEPTION 'binding endpoint must reference a Skill revision' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_skill_binding_types_trigger
  BEFORE INSERT OR UPDATE ON agent_skill_binding
  FOR EACH ROW EXECUTE FUNCTION aip_agent_skill_binding_types();
