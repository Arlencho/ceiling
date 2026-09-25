-- Global identity is separate because PostgreSQL requires partition keys in a PK.
CREATE TABLE decision_keys (
  signature text NOT NULL,
  instruction_index integer NOT NULL CHECK (instruction_index >= 0),
  inner_index integer NOT NULL CHECK (inner_index >= -1),
  block_time timestamptz NOT NULL,
  PRIMARY KEY (signature, instruction_index, inner_index),
  UNIQUE (signature, instruction_index, inner_index, block_time)
);
CREATE TABLE decisions (
  signature text NOT NULL,
  slot bigint NOT NULL CHECK (slot >= 0),
  block_time timestamptz NOT NULL,
  instruction_index integer NOT NULL,
  inner_index integer NOT NULL,
  program_version integer NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('mandate', 'hold', 'trade')),
  rule text NOT NULL,
  agent text NOT NULL,
  owner text NOT NULL,
  kind integer NOT NULL,
  reason integer NOT NULL,
  amount numeric NOT NULL,
  nonce numeric NOT NULL,
  counterparty text NOT NULL,
  suggested_override numeric,
  commitment text NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  source text NOT NULL CHECK (source IN ('grpc', 'webhook', 'backfill', 'logs')),
  PRIMARY KEY (signature, instruction_index, inner_index, block_time),
  FOREIGN KEY (signature, instruction_index, inner_index, block_time)
    REFERENCES decision_keys (signature, instruction_index, inner_index, block_time)
) PARTITION BY RANGE (block_time);
CREATE INDEX decisions_rule_slot ON decisions (rule, slot DESC);
CREATE INDEX decisions_agent_slot ON decisions (agent, slot DESC);
CREATE INDEX decisions_rule_nonce ON decisions (rule, nonce);

CREATE TABLE rules (
  rule text PRIMARY KEY, owner text NOT NULL, agent text NOT NULL,
  mint text, source text, merchant text, cap numeric, per_tx_max numeric,
  expires_at timestamptz, status integer NOT NULL,
  opened_at timestamptz, closed_at timestamptz
);
CREATE TABLE rule_stats (
  rule text PRIMARY KEY,
  requests bigint NOT NULL DEFAULT 0,
  paid bigint NOT NULL DEFAULT 0,
  outside bigint NOT NULL DEFAULT 0,
  allowances bigint NOT NULL DEFAULT 0,
  declines bigint NOT NULL DEFAULT 0,
  first_open_ts timestamptz,
  first_ts timestamptz,
  last_ts timestamptz,
  last_slot bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requests = paid + outside),
  CHECK (paid >= 0 AND outside >= 0 AND allowances >= 0 AND declines >= 0)
);
CREATE TABLE agent_stats (LIKE rule_stats INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE agent_stats RENAME COLUMN rule TO agent;
ALTER TABLE agent_stats ADD PRIMARY KEY (agent);
CREATE TABLE cursors (
  source text PRIMARY KEY CHECK (source IN ('grpc', 'webhook', 'backfill', 'logs')),
  last_slot bigint, last_signature text, finalized_watermark bigint
);
-- Each row stores its current contribution. Nonce siblings are reclassified
-- together so removing any decision, in any order, is exactly reversible.
CREATE TABLE deltas (
  signature text NOT NULL, instruction_index integer NOT NULL, inner_index integer NOT NULL,
  rule text NOT NULL, agent text NOT NULL,
  requests bigint NOT NULL, paid bigint NOT NULL, outside bigint NOT NULL,
  allowances bigint NOT NULL, declines bigint NOT NULL,
  PRIMARY KEY (signature, instruction_index, inner_index),
  FOREIGN KEY (signature, instruction_index, inner_index)
    REFERENCES decision_keys (signature, instruction_index, inner_index)
);
CREATE INDEX deltas_rule ON deltas (rule);
