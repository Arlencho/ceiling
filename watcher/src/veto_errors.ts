export const VetoErrorCode = {
  CapMustBePositive: 6000,
  PerTxMaxMustBePositive: 6001,
  PerTxMaxAboveCap: 6002,
  ExpiryInThePast: 6003,
  PurposeTooLong: 6004,
  MerchantRequired: 6005,
  AgentMustNotBeOwner: 6006,
  SourceNotOwnedByOwner: 6007,
  MintMismatch: 6008,
  SourceMismatch: 6009,
  LedgerMismatch: 6010,
  NotTheAgent: 6011,
  NotTheOwner: 6012,
  InvalidMandatePda: 6013,
  MandateNotActive: 6014,
  MandateStillActive: 6015,
  NonceRequired: 6016,
  AmountMustBePositive: 6017,
  OverrideAboveCap: 6018,
  MathOverflow: 6019
};

export type VetoErrorName = keyof typeof VetoErrorCode;
