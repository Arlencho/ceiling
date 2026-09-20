/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `watcher/idl/veto.json`.
 */
export type Veto = {
  "address": "3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV",
  "metadata": {
    "name": "veto",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Mandate enforcement for agent spending"
  },
  "instructions": [
    {
      "name": "charge",
      "docs": [
        "Submit a charge. Signed by the agent, decided by this program.",
        "",
        "Returns Ok whether the charge is paid or refused. See the module doc",
        "for why a refusal must not be an error."
      ],
      "discriminator": [
        26,
        55,
        197,
        209,
        93,
        77,
        242,
        15
      ],
      "accounts": [
        {
          "name": "agent",
          "docs": [
            "The agent holds authority and nothing else. It is not the owner, it",
            "pays only the transaction fee, and it cannot change any limit."
          ],
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "closeMandate",
      "docs": [
        "Reclaim rent once a mandate is finished. Only the owner, never while active."
      ],
      "discriminator": [
        117,
        87,
        189,
        5,
        254,
        125,
        248,
        180
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "grantOverride",
      "docs": [
        "Let one specific charge through above the per-payment ceiling.",
        "",
        "The owner signs, so the override is explicit. It is written to the",
        "ledger, so it is on the record. It raises the per-payment ceiling only:",
        "the total cap stays absolute."
      ],
      "discriminator": [
        225,
        146,
        123,
        110,
        56,
        16,
        99,
        141
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "openMandate",
      "docs": [
        "Open a mandate and delegate `cap` to it in the same transaction, so the",
        "owner signs exactly once."
      ],
      "discriminator": [
        116,
        145,
        190,
        28,
        86,
        223,
        105,
        74
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "mandate",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  110,
                  100,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.mandateId"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "openMandateArgs"
            }
          }
        }
      ]
    },
    {
      "name": "revokeMandate",
      "docs": [
        "Withdraw the agent's authority immediately, in one owner signature.",
        "",
        "Allowed from any status except already REVOKED, so an EXPIRED or",
        "EXHAUSTED mandate can still drop its SPL delegation. A second revoke",
        "is refused."
      ],
      "discriminator": [
        252,
        97,
        140,
        119,
        67,
        43,
        177,
        108
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "mandate",
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "mandate"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true,
          "relations": [
            "mandate"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "ledger",
      "discriminator": [
        43,
        41,
        21,
        213,
        180,
        176,
        95,
        32
      ]
    },
    {
      "name": "mandate",
      "discriminator": [
        113,
        216,
        98,
        159,
        185,
        63,
        55,
        18
      ]
    }
  ],
  "events": [
    {
      "name": "paid",
      "discriminator": [
        240,
        193,
        17,
        238,
        238,
        210,
        129,
        235
      ]
    },
    {
      "name": "refused",
      "discriminator": [
        230,
        49,
        133,
        208,
        106,
        62,
        106,
        169
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "capMustBePositive",
      "msg": "cap must be greater than zero"
    },
    {
      "code": 6001,
      "name": "perTxMaxMustBePositive",
      "msg": "per-payment maximum must be greater than zero"
    },
    {
      "code": 6002,
      "name": "perTxMaxAboveCap",
      "msg": "per-payment maximum cannot exceed the cap"
    },
    {
      "code": 6003,
      "name": "expiryInThePast",
      "msg": "expiry must be in the future"
    },
    {
      "code": 6004,
      "name": "purposeTooLong",
      "msg": "purpose is longer than the on-chain limit"
    },
    {
      "code": 6005,
      "name": "merchantRequired",
      "msg": "a mandate must name the merchant it may pay"
    },
    {
      "code": 6006,
      "name": "agentMustNotBeOwner",
      "msg": "the agent key must not be the owner key"
    },
    {
      "code": 6007,
      "name": "sourceNotOwnedByOwner",
      "msg": "source token account is not owned by the mandate owner"
    },
    {
      "code": 6008,
      "name": "mintMismatch",
      "msg": "token mint does not match the mandate"
    },
    {
      "code": 6009,
      "name": "sourceMismatch",
      "msg": "source token account does not match the mandate"
    },
    {
      "code": 6010,
      "name": "ledgerMismatch",
      "msg": "ledger does not belong to this mandate"
    },
    {
      "code": 6011,
      "name": "notTheAgent",
      "msg": "signer is not the agent named in the mandate"
    },
    {
      "code": 6012,
      "name": "notTheOwner",
      "msg": "signer is not the owner of this mandate"
    },
    {
      "code": 6013,
      "name": "invalidMandatePda",
      "msg": "mandate address does not match its stored fields"
    },
    {
      "code": 6014,
      "name": "mandateNotActive",
      "msg": "mandate is not active"
    },
    {
      "code": 6015,
      "name": "mandateStillActive",
      "msg": "mandate is still active"
    },
    {
      "code": 6016,
      "name": "nonceRequired",
      "msg": "an override needs a non-zero nonce"
    },
    {
      "code": 6017,
      "name": "amountMustBePositive",
      "msg": "amount must be greater than zero"
    },
    {
      "code": 6018,
      "name": "overrideAboveCap",
      "msg": "an override cannot raise the total cap"
    },
    {
      "code": 6019,
      "name": "mathOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6020,
      "name": "nonceAlreadySettled",
      "msg": "override nonce is at or below the last paid nonce"
    }
  ],
  "types": [
    {
      "name": "entry",
      "docs": [
        "One decision, paid or refused, exactly as the program made it.",
        "",
        "`repr(C)` with explicit padding, because the ledger is a zero-copy account:",
        "the ring is larger than the BPF stack frame and must never be deserialized",
        "onto it."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ts",
            "type": "i64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "counterparty",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "suggestedOverride",
            "docs": [
              "For a refusal, the one-shot override that would have cleared this exact",
              "charge, or zero when no override could. A decline that tells you how to",
              "proceed is the difference between a limit and an answer."
            ],
            "type": "u64"
          },
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "ledger",
      "docs": [
        "A ring of the most recent decisions. Refusals are recorded here with the",
        "same weight as payments, which is the point of the whole program.",
        "",
        "The ring is the authoritative recent window. Longer history is rebuilt by",
        "indexing `Paid` and `Refused` events from transaction logs, so a busy week",
        "wrapping the ring costs nothing."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "total",
            "docs": [
              "Total entries ever written, including those the ring has overwritten."
            ],
            "type": "u32"
          },
          {
            "name": "head",
            "docs": [
              "Index the next entry is written to."
            ],
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pad",
            "type": {
              "array": [
                "u8",
                1
              ]
            }
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "entry"
                  }
                },
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mandate",
      "docs": [
        "A permission to spend, owned by the human and enforced by this program.",
        "",
        "The owner key never leaves Seed Vault and signs only `open_mandate`,",
        "`grant_override`, `revoke_mandate` and `close_mandate`. The agent key signs",
        "`charge` and can do nothing else: it cannot widen any limit, change the",
        "merchant, extend the expiry, or move funds outside this account's rules."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Human who owns the funds and the mandate."
            ],
            "type": "pubkey"
          },
          {
            "name": "agent",
            "docs": [
              "Key allowed to submit charges. Holds authority, never ownership."
            ],
            "type": "pubkey"
          },
          {
            "name": "mint",
            "docs": [
              "Asset this mandate governs."
            ],
            "type": "pubkey"
          },
          {
            "name": "source",
            "docs": [
              "The owner's token account. Funds stay here until a charge is allowed."
            ],
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "docs": [
              "The only wallet that may receive funds under this mandate."
            ],
            "type": "pubkey"
          },
          {
            "name": "mandateId",
            "docs": [
              "Distinguishes several mandates held by the same owner."
            ],
            "type": "u64"
          },
          {
            "name": "cap",
            "docs": [
              "Total that may ever be spent, in base units."
            ],
            "type": "u64"
          },
          {
            "name": "spent",
            "docs": [
              "Spent so far, in base units. Never exceeds `cap`."
            ],
            "type": "u64"
          },
          {
            "name": "perTxMax",
            "docs": [
              "Largest single payment allowed, in base units."
            ],
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "Unix seconds after which nothing may be spent."
            ],
            "type": "i64"
          },
          {
            "name": "overrideAmount",
            "docs": [
              "One-shot allowance the owner granted for a specific charge."
            ],
            "type": "u64"
          },
          {
            "name": "overrideNonce",
            "docs": [
              "Nonce the override applies to. Zero means no override is pending."
            ],
            "type": "u64"
          },
          {
            "name": "lastNonce",
            "docs": [
              "Highest nonce that has been paid. Blocks replay of a settled charge."
            ],
            "type": "u64"
          },
          {
            "name": "purpose",
            "docs": [
              "What the money is for, in the owner's own words, fixed at creation."
            ],
            "type": "string"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "spendCount",
            "type": "u32"
          },
          {
            "name": "refusalCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "openMandateArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandateId",
            "type": "u64"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "cap",
            "type": "u64"
          },
          {
            "name": "perTxMax",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "purpose",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "paid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "spent",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "refused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mandate",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "suggestedOverride",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
