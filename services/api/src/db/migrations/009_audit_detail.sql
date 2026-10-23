-- 009_audit_detail.sql — 审计事件补充结构化明细。
--
-- 状态变更的 `reason` 被契约强制要求填写，但审计行只落 `result` 一个字符串，
-- 吊销理由与前后状态都不可追溯。本迁移只向前追加，不修改已发布的迁移文件。

ALTER TABLE audit_event ADD COLUMN IF NOT EXISTS detail jsonb;
