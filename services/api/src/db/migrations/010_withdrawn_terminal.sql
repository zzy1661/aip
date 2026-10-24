-- 010_withdrawn_terminal.sql — 撤回是终态；撤回要能取消在途操作。
--
-- 背景：撤回（withdraw）把知识版本置为 withdrawn 后，迟到的 worker 仍可能
-- 把同一个版本改回 ready（解析完成）、failed（失败回落），
-- 撤回的知识版本因此被「复活」，来源文件重新可下载。
-- epoch 栅栏挡不住这种情况：迟到的是另一个 operation（parse / reindex），
-- 它持有的是自己的 epoch。
--
-- 本迁移只向前追加，不修改已发布的迁移文件。

-- 1) 撤回是终态：数据库层禁止把 withdrawn 改成任何其他状态。
CREATE OR REPLACE FUNCTION aip_knowledge_revision_withdrawn_terminal() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'knowledge revision % % is withdrawn; withdrawn is a terminal state',
      OLD.knowledge_id, OLD.version USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_revision_withdrawn_terminal
  BEFORE UPDATE ON knowledge_revision
  FOR EACH ROW EXECUTE FUNCTION aip_knowledge_revision_withdrawn_terminal();

-- 2) 撤回会取消该知识版本在途的上传/解析/重建操作。
--    取消与失败不是一回事：失败是「做砸了」，取消是「不再需要做了」。
ALTER TABLE operation DROP CONSTRAINT IF EXISTS operation_state_check;
ALTER TABLE operation ADD CONSTRAINT operation_state_check
  CHECK (state IN ('pending', 'in_progress', 'succeeded', 'failed', 'unknown_outcome', 'cancelled'));
