# Release APK check on a wiped Seeker

Use the signed APK attached to the GitHub release. Record a transaction signature
for an action that signs, or write "seen" for a visual check, and record the time
on every line. Seed Vault signing is the one thing no off-device test covered.
The optional Freeze and Recover actions need a second phone for the guardian;
reading those screens does not. Do not press either unless the founder wants to
exercise guardian recovery. The agent QR path needs a laptop running `veto connect`.

Release link: ____________________  APK SHA-256: ____________________

Date and time zone: ____________________  Founder: ____________________

Solana devnet. Devnet USDC is a test token with no value.

| Check and what you should see | Signature or seen | Time |
| --- | --- | --- |
| On the wiped Seeker, download the APK from the release link and install it; Android completes the install. | | |
| Open Veto for the first time; Learn appears without a development server. | | |
| Connect wallet through Mobile Wallet Adapter with Seed Vault; the authorize identity is `https://veto-hq.github.io` and the name is Veto. | | |
| On the connect screen, read the network line; it says "Your wallet must be set to devnet before you connect", and the wallet is on devnet. | | |
| Add your agent by scanning the companion QR from `veto connect` on a laptop or entering a bare agent address; the intended agent appears. | | |
| Read the approval card; it names USDC, 20 total, 0.50 per payment, the days, and the payee you chose. | | |
| Hold "Hold to approve rule"; Seed Vault asks for one signature and approval completes once. | | |
| Read Rule live; it says "Your rule is live." | | |
| From Rule live, choose "Give your agent its setup"; agent setup says "Your agent can find this rule by itself when it runs the Veto companion. Keep your agent running." | | |
| Continue with "Next: protect your money"; the Protect step offers "Set up later" or "Set up with my second Seeker". Choose either and complete that path. | | |
| Open Overview; the new rule appears with its amounts in USDC. | | |
| Trigger the agent's first decision; a notification arrives and the same decision appears as a row. | | |
| Open a refused row; read its reason and the figure that would allow the payment. | | |
| Choose to allow once; the hold button reads "Allow this one payment of" with the amount, Seed Vault asks for one signature, and the agent's retry pays. | | |
| Revoke the rule; Seed Vault asks for one signature and the rule is revoked. | | |
| Attempt the next charge; it is refused with "mandate not active". | | |
| Close the rule; the remaining funds and the account rent return to the wallet. | | |
| In Hold, create a vault in USDC; the new vault names USDC. | | |
| In Hold setup, choose a guardian key; pick "Your second Seeker", enter the second Seeker address, and the safe address is shown. | | |
| Deposit 5 USDC into Hold; the vault shows the deposit and its new balance. | | |
| Make an everyday withdrawal of 0.5 USDC to a known address; it pays at once and the recipient receives it. | | |
| Request a 3 USDC withdrawal; it is held and the screen shows the unlock time. | | |
| On the guardian's second phone, the held alert arrives; the guardian opens it and can hold "Stop this withdrawal" to stop it. | | |
| Hold "Stop this withdrawal" for that held withdrawal; it is cancelled and does not pay the recipient. | | |
| Read Freeze; the screen explains freezing the vault. Do not press it unless the founder wants to, with the guardian's second phone ready. | | |
| Select a rule and view the widget; it shows that selected rule. | | |
| Turn on the quiet note; the confirmation says "The quiet note is set for &lt;time&gt;." | | |
