# Handoff: design/kimi.html

## Built
- `design/kimi.html`: one self-contained HTML file, no JS, Google Fonts only
  (Fraunces + IBM Plex Sans + IBM Plex Mono). Four 390px phone screens in a
  single horizontal row, labelled 01 Overview, 02 Rules, 03 Decisions,
  04 Share a decision. All content from `docs/DESIGN_BRIEF.md` used verbatim
  (rule SE3 home charging, cap 100, per payment 0.5, expires 19 Dec 2026,
  payee 6i99...PdCG, spent 0.666, the four 20 Sep 2026 decisions with real
  prices, Seed Vault / agent key split).

## Decisions (+why)
- Position: a paper ledger, not another dark neon wallet. Warm paper
  (#f4efe3) phones with ink (#1a1410) typography, framed on a deep warm
  brown page. Defense the brief asks for: the product is a recorded,
  checkable document, so the UI is set like one. It also dodges every
  banned AI look (no near-black app theme, no purple-blue gradient, no
  acid green, no Inter or Space Grotesk, no emoji markers, no identical
  rounded cards; rows are hairline-separated like a ledger).
- Boldness spent in exactly one place, per the brief: the refusal is the
  only solid ink block anywhere in the four screens, with a rotated
  REFUSED stamp like a rubber stamp hit. Paid rows are quiet outlines.
  No red, no warning iconography anywhere; refusal copy says "The rule
  held. Nothing moved."
- Ochre (#a8681c) appears only as the spent-cap meter fill and template
  "Use" affordance, far from the refusal, so it never reads as an alarm.
- SOL used as the unit (brief gives amounts without a unit; it is a
  Solana program, and 0.446+0.2145+0.0055 = 0.666 matches spent).
- 90 days left computed from 20 Sep to 19 Dec 2026.
- Tx signature on the share screen (3Zk9QmWv...rT7dPu) is an invented
  placeholder; the brief supplies none. It is marked devnet.

## Do not repeat
- Nothing failed; the file was verified by headless Chrome screenshots,
  not by eyeballing markup.

## Evidence
- `grep -c '—' design/kimi.html` -> 0 (no em dash; en dash also absent).
- No red hexes / error iconography: grep for common red hex values and
  warning glyphs returns empty.
- Headless Chrome screenshots at 1900x1200 confirm: all four screens
  visible in one row with labels, refusal hero is the visually dominant
  element, no text overflow after two wrap fixes (share doc amount,
  overview footer, override line).
- Only file touched: `design/kimi.html` (git status clean otherwise).

## Open questions
- Currency unit (SOL) and the placeholder tx signature need swapping for
  real values if the program uses a different denomination or a real
  devnet signature exists.

## Next hint
For the critic: judge screen 03 (Decisions) first. Check that a stranger
reads the refusal as the product succeeding, that paid and refused rows
share one ledger, and that the override line ("Override of 6.2325 SOL
would have cleared it") plus the transaction link survive on the refusal
card per the brief.
