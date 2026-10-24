-- 011_review_approved_final.sql — 已批准的审核结论是终态，不可被改判。
--
-- 背景（ZACH-10 复审发现，ZACH-17 裁决 a）：已批准且可下载的知识版本被再次审核为
-- rejected 时，接口返回 200；之后检索按 review_status='approved' 过滤不到该版本，
-- 而下载仍按文档级授权放行正文——同一个状态在两条路径上被解释成两种结果。
--
-- 裁决 a：禁止把已 approved 的版本改判为 rejected。服务层在写入前就拒绝该改判，
-- 返回稳定错误码 REVIEW_ALREADY_APPROVED（409），状态与审核记录都不变。
-- 本触发器是数据层的兜底：即便有绕过服务层的写入（直连 SQL、未来的代码路径），
-- approved 的审核结论也不会被改写。
--
-- 只向前追加：不改写既有数据、不删除任何行，只约束之后的写入。
-- 与 010 的 withdrawn 终态触发器并列，二者互不覆盖：
-- 010 约束 status，011 约束 review_status。

-- AIP01 是本仓自定义 SQLSTATE：审核终态（approved 不可改判）。
-- 单列出来是为了让它在 API 层映射成稳定错误码，而不是混进通用 500。
CREATE OR REPLACE FUNCTION aip_knowledge_revision_review_final() RETURNS trigger AS $$
BEGIN
  IF OLD.review_status = 'approved' AND NEW.review_status <> 'approved' THEN
    RAISE EXCEPTION 'knowledge revision % % is approved; an approved review verdict is final',
      OLD.knowledge_id, OLD.version USING ERRCODE = 'AIP01';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_revision_review_final
  BEFORE UPDATE ON knowledge_revision
  FOR EACH ROW EXECUTE FUNCTION aip_knowledge_revision_review_final();
