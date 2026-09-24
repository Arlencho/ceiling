export const PAYEE_GUIDANCE =
  'Who the agent may pay. The program refuses a charge unless the token account it pays is owned by this address.';

export const LARGEST_PAYMENT_GUIDANCE =
  'The largest single payment. A charge above this is refused unless you allow that one charge, and that allowance cannot raise the total cap.';

export const TOTAL_CAP_GUIDANCE =
  'The total this rule can pay. A charge that would pass what remains is refused, and allowing one charge cannot raise this total.';

export const EXPIRY_GUIDANCE =
  'A number of days from now. Open stores that time on chain, and a charge at or after it is refused.';
