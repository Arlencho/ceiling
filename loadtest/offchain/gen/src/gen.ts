import { loadVetoIdl, type VetoIdl } from "./idl.js";
import { base58Encode, derivePubkey, deriveSignature, type DerivedKey } from "./keys.js";
import { mulberry32, pickWeighted, randInt, type Rng } from "./rng.js";

// Same shape the indexer consumes (TxView in indexer/src/types.ts), with the
// instruction data held as a Buffer until it is serialized to base58.
export type CompiledIxOut = {
  programId: string;
  accounts: string[];
  data: Buffer;
};

export type TxViewOut = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: null;
  logs: string[];
  accountKeys: string[];
  instructions: CompiledIxOut[];
};

export type OpenIntent = {
  kind: "open";
  agent: number;
  rule: number;
  mandate: string;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
};

export type DecisionIntent = {
  kind: "paid" | "refused";
  agent: number;
  rule: number;
  mandate: string;
  destination: string;
  amount: bigint;
  nonce: bigint;
  reason: number;
  suggestedOverride: bigint;
};

export type OverrideIntent = {
  kind: "override";
  agent: number;
  rule: number;
  mandate: string;
  amount: bigint;
  nonce: bigint;
};

export type Intent = OpenIntent | DecisionIntent | OverrideIntent;

export type Generated = { tx: TxViewOut; intent: Intent };

export type GenConfig = {
  agents: number;
  rules: number;
  transactions: number;
  paid: number;
  refused: number;
  override: number;
  seed: number;
  startSlot?: number;
  startTime?: number;
  idl?: VetoIdl;
};

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// Mirrors reason_text in programs/veto/src/lib.rs so the text log a charge
// writes matches what a real refused charge writes on chain.
const REASON_TEXT: Record<number, string> = {
  2: "past expiry",
  4: "merchant not allowed",
  5: "over per-payment maximum",
  6: "over remaining cap",
};
const REFUSAL_REASONS = [5, 6, 2, 4];

function u64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function i64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(value);
  return buf;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

type RuleProfile = {
  merchant: DerivedKey;
  destination: DerivedKey;
  cap: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  purpose: string;
};

type MandateState = {
  agent: number;
  rule: number;
  key: DerivedKey;
  ledger: DerivedKey;
  source: DerivedKey;
  owner: DerivedKey;
  agentKey: DerivedKey;
  profile: RuleProfile;
  spent: bigint;
  nonce: bigint;
};

function validate(config: GenConfig): void {
  if (!Number.isInteger(config.seed) || config.seed < 0) {
    throw new Error("seed must be a non-negative integer");
  }
  if (!Number.isInteger(config.agents) || config.agents < 1) {
    throw new Error("agents must be a positive integer");
  }
  if (!Number.isInteger(config.rules) || config.rules < 1) {
    throw new Error("rules must be a positive integer");
  }
  if (!Number.isInteger(config.transactions) || config.transactions < 0) {
    throw new Error("transactions must be a non-negative integer");
  }
  for (const [name, w] of [
    ["paid", config.paid],
    ["refused", config.refused],
    ["override", config.override],
  ] as const) {
    if (!Number.isFinite(w) || w < 0) throw new Error(`${name} weight must be a non-negative number`);
  }
  if (config.transactions > 0 && config.paid + config.refused + config.override <= 0) {
    throw new Error("at least one of --paid, --refused, --override must be positive");
  }
}

export function generate(config: GenConfig): Generated[] {
  validate(config);
  const idl = config.idl ?? loadVetoIdl();
  const rng = mulberry32(config.seed);
  const slot0 = config.startSlot ?? 250_000_000;
  const time0 = config.startTime ?? 1_786_000_000;
  const mint = derivePubkey(config.seed, "mint");
  const out: Generated[] = [];
  let seq = 0;

  const ruleProfiles: RuleProfile[] = [];
  for (let r = 0; r < config.rules; r++) {
    const cap = BigInt(randInt(rng, 1_000_000, 1_000_000_000));
    const perTxMax = cap / BigInt(randInt(rng, 2, 10));
    ruleProfiles.push({
      merchant: derivePubkey(config.seed, `merchant:${r}`),
      destination: derivePubkey(config.seed, `destination:${r}`),
      cap,
      perTxMax,
      expiresAt: BigInt(time0 + randInt(rng, 86_400, 86_400 * 30)),
      purpose: `loadtest rule ${r}`,
    });
  }

  const mandates: MandateState[] = [];
  for (let a = 0; a < config.agents; a++) {
    const owner = derivePubkey(config.seed, `owner:${a}`);
    const agentKey = derivePubkey(config.seed, `agent:${a}`);
    for (let r = 0; r < config.rules; r++) {
      mandates.push({
        agent: a,
        rule: r,
        key: derivePubkey(config.seed, `mandate:${a}:${r}`),
        ledger: derivePubkey(config.seed, `ledger:${a}:${r}`),
        source: derivePubkey(config.seed, `source:${a}:${r}`),
        owner,
        agentKey,
        profile: ruleProfiles[r]!,
        spent: 0n,
        nonce: 0n,
      });
    }
  }

  const frame = (middle: string[], compute: number): string[] => [
    `Program ${idl.programId} invoke [1]`,
    ...middle,
    `Program ${idl.programId} consumed ${compute} of 200000 compute units`,
    `Program ${idl.programId} success`,
  ];

  const emit = (m: MandateState, middle: string[], instructions: CompiledIxOut[], intent: Intent): void => {
    const accountKeys: string[] = [];
    for (const ix of instructions) {
      for (const key of ix.accounts) {
        if (!accountKeys.includes(key)) accountKeys.push(key);
      }
    }
    accountKeys.push(idl.programId);
    out.push({
      tx: {
        signature: deriveSignature(config.seed, `tx:${seq}`),
        slot: slot0 + seq * 2,
        blockTime: time0 + seq * 2,
        err: null,
        logs: frame(middle, randInt(rng, 2_000, 30_000)),
        accountKeys,
        instructions,
      },
      intent,
    });
    seq += 1;
  };

  // Setup phase: one open_mandate per agent per rule, with borsh encoded args.
  for (const m of mandates) {
    const mandateId = BigInt(m.agent * config.rules + m.rule + 1);
    const data = Buffer.concat([
      idl.ixs.openMandate,
      u64(mandateId),
      m.agentKey.bytes,
      m.profile.merchant.bytes,
      u64(m.profile.cap),
      u64(m.profile.perTxMax),
      i64(m.profile.expiresAt),
      borshString(m.profile.purpose),
    ]);
    const ix: CompiledIxOut = {
      programId: idl.programId,
      accounts: [
        m.owner.base58,
        m.key.base58,
        m.ledger.base58,
        m.source.base58,
        mint.base58,
        TOKEN_PROGRAM_ID,
        SYSTEM_PROGRAM_ID,
      ],
      data,
    };
    emit(
      m,
      [
        `Program log: VETO OPENED cap=${m.profile.cap} per_tx_max=${m.profile.perTxMax} expires_at=${m.profile.expiresAt} purpose=${m.profile.purpose}`,
      ],
      [ix],
      {
        kind: "open",
        agent: m.agent,
        rule: m.rule,
        mandate: m.key.base58,
        cap: m.profile.cap,
        perTxMax: m.profile.perTxMax,
        expiresAt: m.profile.expiresAt,
        purpose: m.profile.purpose,
      },
    );
  }

  const chargeIx = (m: MandateState, amount: bigint, nonce: bigint): CompiledIxOut => ({
    programId: idl.programId,
    accounts: [
      m.agentKey.base58,
      m.key.base58,
      m.ledger.base58,
      m.source.base58,
      m.profile.destination.base58,
      mint.base58,
      TOKEN_PROGRAM_ID,
    ],
    data: Buffer.concat([idl.ixs.charge, u64(amount), u64(nonce)]),
  });

  const weights = [config.paid, config.refused, config.override];
  for (let i = 0; i < config.transactions; i++) {
    const m = mandates[randInt(rng, 0, mandates.length - 1)]!;
    m.nonce += 1n;
    const nonce = m.nonce;
    const pick = pickWeighted(rng, weights);
    if (pick === 0) {
      const amount = BigInt(randInt(rng, 1, Number(m.profile.perTxMax)));
      m.spent += amount;
      const remaining = m.profile.cap - m.spent;
      const event = Buffer.concat([idl.events.paid, m.key.bytes, u64(amount), u64(nonce), u64(m.spent)]);
      emit(
        m,
        [
          `Program log: VETO PAID amount=${amount} spent=${m.spent} of cap=${m.profile.cap} remaining=${remaining}`,
          `Program data: ${event.toString("base64")}`,
        ],
        [chargeIx(m, amount, nonce)],
        {
          kind: "paid",
          agent: m.agent,
          rule: m.rule,
          mandate: m.key.base58,
          destination: m.profile.destination.base58,
          amount,
          nonce,
          reason: 0,
          suggestedOverride: 0n,
        },
      );
    } else if (pick === 1) {
      const reason = REFUSAL_REASONS[randInt(rng, 0, REFUSAL_REASONS.length - 1)]!;
      const amount = refusalAmount(rng, m.profile, reason);
      const event = Buffer.concat([
        idl.events.refused,
        m.key.bytes,
        u64(amount),
        u64(nonce),
        Buffer.from([reason]),
        u64(amount),
      ]);
      const remaining = m.profile.cap - m.spent;
      emit(
        m,
        [
          `Program log: VETO REFUSED reason=${reason} (${REASON_TEXT[reason]}) amount=${amount} per_tx_max=${m.profile.perTxMax} remaining=${remaining} override_to_clear=${amount}`,
          `Program data: ${event.toString("base64")}`,
        ],
        [chargeIx(m, amount, nonce)],
        {
          kind: "refused",
          agent: m.agent,
          rule: m.rule,
          mandate: m.key.base58,
          destination: m.profile.destination.base58,
          amount,
          nonce,
          reason,
          suggestedOverride: amount,
        },
      );
    } else {
      const amount = BigInt(randInt(rng, 1, Number(m.profile.perTxMax)));
      const ix: CompiledIxOut = {
        programId: idl.programId,
        accounts: [m.owner.base58, m.key.base58, m.ledger.base58, m.source.base58, TOKEN_PROGRAM_ID],
        data: Buffer.concat([idl.ixs.grantOverride, u64(amount), u64(nonce)]),
      };
      emit(
        m,
        [`Program log: VETO OVERRIDE amount=${amount} nonce=${nonce}`],
        [ix],
        {
          kind: "override",
          agent: m.agent,
          rule: m.rule,
          mandate: m.key.base58,
          amount,
          nonce,
        },
      );
    }
  }
  return out;
}

function refusalAmount(rng: Rng, profile: RuleProfile, reason: number): bigint {
  if (reason === 5) {
    return profile.perTxMax + BigInt(randInt(rng, 1, Number(profile.perTxMax)));
  }
  if (reason === 6) {
    return profile.cap + BigInt(randInt(rng, 1, 1_000_000));
  }
  return BigInt(randInt(rng, 1, Number(profile.perTxMax)));
}

// NDJSON serialization. Instruction data goes out base58 encoded, the same
// encoding the indexer accepts in decodeIxData.
export function toNdjsonLine(tx: TxViewOut): string {
  return JSON.stringify({
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    err: tx.err,
    logs: tx.logs,
    accountKeys: tx.accountKeys,
    instructions: tx.instructions.map((ix) => ({
      programId: ix.programId,
      accounts: ix.accounts,
      data: base58Encode(ix.data),
    })),
  });
}
