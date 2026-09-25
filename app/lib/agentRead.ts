import { CHAIN_BUSY, CHAIN_UNREACHABLE, type MandateReadStatus } from './mandateRead';

export type AgentReadStatus = 'loading' | 'empty' | 'error' | 'ready';

export function describeAgentRead(args: {
  configError: string | null;
  mandateStatus: MandateReadStatus;
  chainError: string | null;
  loadError: string | null;
  ready: boolean;
  nowMs: number;
  mandateCount: number;
  historiesReady: boolean;
}): { status: AgentReadStatus; error: string | null; notice: string | null } {
  if (args.configError) {
    return { status: 'error', error: args.configError, notice: null };
  }
  if (args.mandateStatus === 'rate-limited') {
    return { status: 'loading', error: null, notice: CHAIN_BUSY };
  }
  if (args.loadError || args.mandateStatus === 'failed') {
    return { status: 'error', error: CHAIN_UNREACHABLE, notice: CHAIN_UNREACHABLE };
  }
  if (!args.ready || args.nowMs === 0 || args.mandateStatus === 'not-read') {
    return { status: 'loading', error: null, notice: null };
  }
  if (args.mandateCount > 0 && !args.historiesReady) {
    return { status: 'loading', error: null, notice: null };
  }
  if (args.mandateCount === 0) {
    return { status: 'empty', error: null, notice: null };
  }
  if (args.chainError) {
    return { status: 'ready', error: null, notice: CHAIN_UNREACHABLE };
  }
  return { status: 'ready', error: null, notice: null };
}
