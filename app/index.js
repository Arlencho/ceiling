// Polyfills MUST be fully applied before `expo-router/entry` is evaluated.
//
// @solana/web3.js and @solana/spl-token expect Node's Buffer and
// crypto.getRandomValues, neither of which React Native ships. If those globals
// are missing when web3.js is first evaluated, keypair generation and
// transaction serialization throw, and the crash reads like a Mobile Wallet
// Adapter or Metro problem rather than a missing global.
//
// Side-effect imports are evaluated in source order, so ./polyfills runs to
// completion before the router module is evaluated. Do not inline the polyfill
// assignments into this file and do not reorder these two lines: statements in
// a module body run AFTER every import in that module has been evaluated, which
// would silently put the router first.
import './polyfills';
// Defined after the polyfills, so a background launch can read a ledger.
// Do not move this above ./polyfills, and do not drop it: the router import
// below is what starts the UI, and the task has to exist before that.
import './lib/decisionNotifyTask';
import { registerHomeWidgets } from './widgets/register';
import 'expo-router/entry';

registerHomeWidgets();
