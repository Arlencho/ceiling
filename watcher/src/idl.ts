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
    }
  ],
  "types": [
    {
      "name": "entry",
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
            "type": "u32"
          },
          {
            "name": "head",
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
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "source",
            "type": "pubkey"
          },
          {
            "name": "merchant",
            "type": "pubkey"
          },
          {
            "name": "mandateId",
            "type": "u64"
          },
          {
            "name": "cap",
            "type": "u64"
          },
          {
            "name": "spent",
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
            "name": "overrideAmount",
            "type": "u64"
          },
          {
            "name": "overrideNonce",
            "type": "u64"
          },
          {
            "name": "lastNonce",
            "type": "u64"
          },
          {
            "name": "purpose",
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
