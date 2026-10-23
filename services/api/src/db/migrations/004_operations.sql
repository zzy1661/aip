-- 004_operations.sql — 持久化操作登记、幂等记录与审计事件。

CREATE TABLE operation (
  scope_id         text        NOT NULL,
  id               uuid        NOT NULL,
  subject          text        NOT NULL,
  kind             text        NOT NULL,
  idempotency_key  text        NOT NULL,
  request_hash     text        NOT NULL,
  state            text        NOT NULL,
  resource_id      uuid,
  remote_id        text,
  attempt          integer     NOT NULL DEFAULT 0,
  epoch            bigint      NOT NULL DEFAULT 1,
  lease_until      timestamptz,
  next_attempt_at  timestamptz,
  last_error       text,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id),
  UNIQUE (scope_id, subject, kind, idempotency_key),
  CONSTRAINT operation_state_check
    CHECK (state IN ('pending', 'in_progress', 'succeeded', 'failed', 'unknown_outcome'))
);

CREATE INDEX operation_pending_idx
  ON operation (scope_id, state, next_attempt_at);

CREATE INDEX operation_resource_idx
  ON operation (scope_id, resource_id);

CREATE TABLE idempotency_record (
  scope_id       text        NOT NULL,
  subject        text        NOT NULL,
  operation      text        NOT NULL,
  idempotency_key text       NOT NULL,
  request_hash   text        NOT NULL,
  status_code    integer     NOT NULL,
  response_body  jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, subject, operation, idempotency_key)
);

CREATE TABLE audit_event (
  scope_id     text        NOT NULL,
  id           uuid        NOT NULL,
  subject      text        NOT NULL,
  actor_source text        NOT NULL,
  trace_id     text        NOT NULL,
  operation    text        NOT NULL,
  resource_ref text,
  result       text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, id)
);

CREATE INDEX audit_event_resource_idx
  ON audit_event (scope_id, resource_ref, created_at);
