# Try Veto on your Seeker

For Seeker owners testing before October 8, 2026.

Veto lets you set spending rules for an agent and see which payments were paid or refused.
Its Hold vault makes withdrawals to new addresses wait so you can stop them.

**Everything here is devnet test money with no value.**

## 5-minute setup

1. Download and install the APK from the [latest release](https://github.com/Arlencho/veto/releases/latest).
2. Set your Seed Vault wallet to devnet and copy your own wallet address.
3. Get devnet SOL at [Solana Faucet](https://faucet.solana.com) and devnet USDC at
   [Circle Faucet](https://faucet.circle.com). Choose Solana devnet for USDC.
   Use your own wallet address at both faucets.
4. Open Veto and follow the first-run steps. Use the test-agent choice below when asked to add an agent.

Faucets and confirmations can take longer than five minutes.

## Three things to try

### 1. Write a rule and look for a payment and a refusal

Choose **Create a test agent on this phone**, name it, then **Review the rule**.
Set **Payee**, **Purpose**, **Most per payment** and **Most in total, ever** to a
small test budget you can fund. Use a payee address you control, different from the
agent address. Use **Press and hold to approve rule** and approve in Seed Vault.

Open **Decisions**. The goal is to see one payment within the rule and one refusal
above **Most per payment**. Current limitation: the phone test-agent path creates a
key but does not submit payments, and the app has no button to run these two requests.
If you only have the phone test agent, report this task as blocked rather than waiting
for decisions to appear. A separately running agent must submit requests under its own
approved rule for those records to appear.

### 2. Hold a withdrawal, then stop it

From **Overview**, open **Hold**, then **Set up a vault**. Enter a small amount,
such as 1 devnet USDC. Choose **Next: set the rules**, set a daily limit and wait,
then **Next: choose a guardian key**.

Choose **A second key in Seed Vault on this phone** if available, or **Your second Seeker**
and enter its address. Check **Safe address**. If your wallet exposes only one account
and you have no second Seeker, report this task as blocked.
Use **Press and hold to sign with your key on this phone**, approve in Seed Vault,
then **Done**.

Open your vault, enter **Amount** (for example 0.1 USDC) and a **Destination address**
the vault has never paid. Use another wallet address you control.
Check that the button says **Press and hold to sign. This will be held.**, then hold it
and sign. On the held withdrawal, use **Press and hold to stop this withdrawal** and
sign. Check that the withdrawal is no longer waiting and the money remains in the vault.

### 3. Look at your agent's grade

Open **Agents** and find your agent. A new agent shows **Too new to grade** until it
has at least 10 requests and three days of history. Open **See how grades work**.
Does the explanation make sense? A grade describes behaviour, not safety.

## Tell us

[Send tester feedback](https://github.com/Arlencho/veto/issues/new?template=tester-feedback.yml),
including anything that blocked a task. The optional wallet address is for the tester list;
issues are public. Never include a recovery phrase or private key.
