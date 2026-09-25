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
      "name": "applyChange",
      "discriminator": [
        248,
        177,
        9,
        41,
        50,
        98,
        255,
        50
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelChange",
      "discriminator": [
        100,
        30,
        4,
        148,
        3,
        244,
        243,
        168
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
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
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "source",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "mint",
          "relations": [
            "vault"
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
        }
      ]
    },
    {
      "name": "execute",
      "discriminator": [
        130,
        221,
        242,
        154,
        13,
        193,
        189,
        29
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "freeze",
      "discriminator": [
        255,
        91,
        207,
        84,
        251,
        194,
        254,
        63
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
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
      "name": "initVault",
      "discriminator": [
        77,
        79,
        85,
        150,
        33,
        217,
        52,
        106
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "args.vaultId"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
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
              "name": "initVaultArgs"
            }
          }
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
      "name": "proposeChange",
      "discriminator": [
        167,
        211,
        18,
        222,
        93,
        215,
        74,
        159
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "values",
          "type": {
            "defined": {
              "name": "holdChange"
            }
          }
        }
      ]
    },
    {
      "name": "recover",
      "discriminator": [
        108,
        216,
        38,
        58,
        109,
        146,
        116,
        17
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
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
    },
    {
      "name": "skip",
      "discriminator": [
        154,
        63,
        181,
        53,
        19,
        26,
        117,
        45
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "guardian",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "stop",
      "discriminator": [
        42,
        133,
        32,
        60,
        171,
        253,
        184,
        155
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault.owner",
                "account": "holdVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unfreeze",
      "discriminator": [
        133,
        160,
        68,
        253,
        80,
        232,
        218,
        247
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "guardian",
          "signer": true,
          "optional": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "holdVault"
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
                  104,
                  111,
                  108,
                  100,
                  45,
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
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  45,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          },
          "relations": [
            "vault"
          ]
        },
        {
          "name": "destination",
          "writable": true
        },
        {
          "name": "mint",
          "relations": [
            "vault"
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
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "holdLedger",
      "discriminator": [
        195,
        103,
        143,
        50,
        70,
        255,
        84,
        161
      ]
    },
    {
      "name": "holdVault",
      "discriminator": [
        225,
        219,
        122,
        198,
        245,
        163,
        91,
        55
      ]
    },
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
      "name": "holdChangeApplied",
      "discriminator": [
        214,
        73,
        25,
        25,
        100,
        242,
        158,
        103
      ]
    },
    {
      "name": "holdChangeCancelled",
      "discriminator": [
        105,
        91,
        17,
        180,
        121,
        125,
        6,
        176
      ]
    },
    {
      "name": "holdChangeProposed",
      "discriminator": [
        10,
        12,
        18,
        221,
        178,
        129,
        99,
        89
      ]
    },
    {
      "name": "holdDeposited",
      "discriminator": [
        14,
        183,
        196,
        175,
        23,
        89,
        172,
        201
      ]
    },
    {
      "name": "holdExecuted",
      "discriminator": [
        0,
        66,
        40,
        156,
        42,
        195,
        127,
        203
      ]
    },
    {
      "name": "holdFrozen",
      "discriminator": [
        109,
        125,
        222,
        166,
        136,
        63,
        153,
        164
      ]
    },
    {
      "name": "holdHeld",
      "discriminator": [
        213,
        77,
        28,
        129,
        215,
        57,
        137,
        224
      ]
    },
    {
      "name": "holdOpened",
      "discriminator": [
        43,
        30,
        161,
        191,
        183,
        229,
        201,
        113
      ]
    },
    {
      "name": "holdPaid",
      "discriminator": [
        75,
        217,
        168,
        36,
        135,
        161,
        113,
        223
      ]
    },
    {
      "name": "holdRecovered",
      "discriminator": [
        26,
        178,
        12,
        148,
        227,
        199,
        14,
        232
      ]
    },
    {
      "name": "holdRefused",
      "discriminator": [
        154,
        131,
        154,
        169,
        135,
        21,
        58,
        52
      ]
    },
    {
      "name": "holdSkipped",
      "discriminator": [
        26,
        204,
        98,
        122,
        152,
        219,
        27,
        65
      ]
    },
    {
      "name": "holdStopped",
      "discriminator": [
        204,
        29,
        182,
        240,
        51,
        231,
        188,
        149
      ]
    },
    {
      "name": "holdUnfreezeScheduled",
      "discriminator": [
        158,
        133,
        180,
        244,
        162,
        69,
        74,
        117
      ]
    },
    {
      "name": "holdUnfrozen",
      "discriminator": [
        115,
        249,
        65,
        139,
        158,
        138,
        7,
        112
      ]
    },
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
    },
    {
      "code": 6021,
      "name": "delayNotAllowed",
      "msg": "delay must be 1, 2, or 3 days"
    },
    {
      "code": 6022,
      "name": "shareOutOfRange",
      "msg": "share must be between 0 and 10000 basis points"
    },
    {
      "code": 6023,
      "name": "safeAddressRequired",
      "msg": "safe address is required"
    },
    {
      "code": 6024,
      "name": "guardianIsOwner",
      "msg": "the guardian must be a different key from the owner"
    },
    {
      "code": 6025,
      "name": "positiveAmountRequired",
      "msg": "amount must be greater than zero"
    },
    {
      "code": 6026,
      "name": "holdMathOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6027,
      "name": "notTheVaultOwner",
      "msg": "signer is not the owner of this vault"
    },
    {
      "code": 6028,
      "name": "notOwnerOrGuardian",
      "msg": "signer is not the owner or the guardian"
    },
    {
      "code": 6029,
      "name": "notTheGuardian",
      "msg": "signer is not the guardian"
    },
    {
      "code": 6030,
      "name": "bothKeysRequired",
      "msg": "both the owner and the guardian must sign"
    },
    {
      "code": 6031,
      "name": "invalidVaultPda",
      "msg": "vault address does not match its stored fields"
    },
    {
      "code": 6032,
      "name": "vaultTokenMismatch",
      "msg": "vault token account does not match the vault"
    },
    {
      "code": 6033,
      "name": "holdMintMismatch",
      "msg": "token mint does not match the vault"
    },
    {
      "code": 6034,
      "name": "holdSourceNotOwned",
      "msg": "source token account is not owned by the vault owner"
    },
    {
      "code": 6035,
      "name": "destinationIsVault",
      "msg": "destination is the vault token account"
    },
    {
      "code": 6036,
      "name": "destinationMismatch",
      "msg": "destination does not match the pending withdrawal"
    },
    {
      "code": 6037,
      "name": "notTheSafeAddress",
      "msg": "destination is not the safe address"
    },
    {
      "code": 6038,
      "name": "withdrawalNotPending",
      "msg": "withdrawal is not pending"
    },
    {
      "code": 6039,
      "name": "tooEarly",
      "msg": "the chain clock has not reached the unlock time"
    },
    {
      "code": 6040,
      "name": "vaultFrozen",
      "msg": "the vault is frozen"
    },
    {
      "code": 6041,
      "name": "notFrozen",
      "msg": "the vault is not frozen"
    },
    {
      "code": 6042,
      "name": "unfreezeNotReady",
      "msg": "unfreeze is still waiting on the chain clock"
    },
    {
      "code": 6043,
      "name": "changeAlreadyPending",
      "msg": "a loosening change is already pending"
    },
    {
      "code": 6044,
      "name": "noPendingChange",
      "msg": "there is no pending change"
    },
    {
      "code": 6045,
      "name": "changeNotReady",
      "msg": "the chain clock has not reached the change"
    },
    {
      "code": 6046,
      "name": "changeUnchanged",
      "msg": "the proposed values match the current rules"
    },
    {
      "code": 6047,
      "name": "nothingToRecover",
      "msg": "the vault token account is empty"
    },
    {
      "code": 6048,
      "name": "holdInsufficientFunds",
      "msg": "the vault cannot cover this withdrawal"
    },
    {
      "code": 6049,
      "name": "badVaultAuthority",
      "msg": "token account authority is not the vault"
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
      "name": "holdChange",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdChangeApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "fields",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdChangeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdChangeProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          },
          {
            "name": "fields",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "holdEntry",
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
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "withdrawalId",
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
      "name": "holdExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdFrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdHeld",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "unlockAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "holdLedger",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
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
                    "name": "holdEntry"
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
      "name": "holdOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "holdPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdRecovered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdRefused",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "holdSkipped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdStopped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "holdUnfreezeScheduled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "holdUnfrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "holdVault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vaultToken",
            "type": "pubkey"
          },
          {
            "name": "vaultId",
            "type": "u64"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "windowSpent",
            "type": "u64"
          },
          {
            "name": "windowStart",
            "type": "i64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "unfreezeAt",
            "type": "i64"
          },
          {
            "name": "nextWithdrawalId",
            "type": "u64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          },
          {
            "name": "frozen",
            "type": "bool"
          },
          {
            "name": "knownLen",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tokenBump",
            "type": "u8"
          },
          {
            "name": "ledgerBump",
            "type": "u8"
          },
          {
            "name": "known",
            "type": {
              "array": [
                "pubkey",
                16
              ]
            }
          },
          {
            "name": "pending",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "pendingWithdrawal"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "change",
            "type": {
              "defined": {
                "name": "pendingChange"
              }
            }
          }
        ]
      }
    },
    {
      "name": "initVaultArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vaultId",
            "type": "u64"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
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
      "name": "pendingChange",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "fields",
            "type": "u8"
          },
          {
            "name": "bigShareBps",
            "type": "u16"
          },
          {
            "name": "dailyLimit",
            "type": "u64"
          },
          {
            "name": "delaySecs",
            "type": "i64"
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "safeAddress",
            "type": "pubkey"
          },
          {
            "name": "effectiveAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pendingWithdrawal",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "unlockAt",
            "type": "i64"
          },
          {
            "name": "status",
            "type": "u8"
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
