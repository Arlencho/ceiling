import { rulePillLabel, type ReadFace } from '../lib/mandateRead';
import { LiveRules } from './agents/chrome';

export function RuleReadPill({ face, liveCount }: { face: ReadFace; liveCount: number }) {
  const proven = face === 'proven';
  return <LiveRules count={proven ? liveCount : 0} label={rulePillLabel(face, liveCount)} pending={!proven} />;
}
