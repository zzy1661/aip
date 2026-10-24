-- 007_revision_immutability.sql — 补齐版本事实的不可变列。
--
-- content_hash 的计算输入包含 title 与 description（见 registry/service.ts），
-- 但 001 的冻结列清单漏掉了这两列：持有 DML 权限的角色可以直接改标题而哈希不变，
-- 「内容寻址」在 DB 层被削弱。本迁移只向前追加，不修改已发布的迁移文件。

CREATE OR REPLACE FUNCTION aip_asset_revision_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset_revision rows are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.description IS DISTINCT FROM OLD.description
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
