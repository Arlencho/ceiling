import { useEffect, useState, type ComponentType } from 'react';
import { ActivityIndicator } from 'react-native';

import type { OpenMandateResult } from '../../lib/chain';
import { formatBaseUnits } from '../../lib/format';
import type { RuleRequestV1 } from '../../lib/ruleRequest';
import { useChain } from '../../lib/useChain';
import { colors } from '../theme';
import { LiveAgentSetup } from './LiveAgentSetup';
import { liveFactsFromMandate, RuleLiveScreen } from './RuleLiveScreen';

type Stage = 'connected' | 'agent' | 'paste' | 'name' | 'approve' | 'live' | 'setup' | 'alerts';

export function LaterStages(props: {
  stage: Stage;
  cluster: string | null;
  agentAddress: string | null;
  agentName: string;
  request: RuleRequestV1 | null;
  opened: OpenMandateResult | null;
  amountsReady: boolean;
  decimals: number;
  explorerCluster: string | null;
  rpcUrl: string | null;
  onStage: (stage: Stage) => void;
  onOpened: (result: OpenMandateResult) => void;
  onFinish: () => void;
}) {
  if (props.stage === 'approve') {
    return (
      <ApproveStage
        mode={props.request ? 'request' : 'template'}
        request={props.request}
        initialAgent={props.agentAddress ?? undefined}
        onDecline={() => props.onStage('name')}
        onOpened={(result) => {
          props.onOpened(result);
          props.onStage('live');
        }}
      />
    );
  }

  if (props.stage === 'live') {
    if (!props.opened) {
      return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
    }
    return (
      <RuleLiveScreen
        cluster={props.cluster}
        facts={liveFactsFromMandate({
          mandate: props.opened.mandate,
          decimals: props.amountsReady ? props.decimals : null,
          signature: props.opened.signature,
          cluster: props.explorerCluster,
          rpcUrl: props.rpcUrl,
          agentName: props.agentName,
        })}
        onSetup={() => props.onStage('setup')}
        onOverview={props.onFinish}
      />
    );
  }

  if (props.stage === 'setup') {
    const summary = props.opened
      ? liveFactsFromMandate({
          mandate: props.opened.mandate,
          decimals: props.amountsReady ? props.decimals : null,
          signature: props.opened.signature,
          cluster: props.explorerCluster,
          rpcUrl: props.rpcUrl,
          agentName: props.agentName,
        }).summary
      : null;
    return (
      <LiveAgentSetup
        mandate={props.opened?.mandate ?? null}
        cluster={props.cluster}
        summary={summary}
        onAlerts={() => props.onStage('alerts')}
        onOverview={props.onFinish}
      />
    );
  }

  return (
    <AlertsGate
      cluster={props.cluster}
      opened={props.opened}
      onFinish={props.onFinish}
      amountsReady={props.amountsReady}
    />
  );
}

function ApproveStage(props: {
  mode: 'request' | 'template';
  request: RuleRequestV1 | null;
  initialAgent?: string;
  onDecline: () => void;
  onOpened: (result: OpenMandateResult) => void;
}) {
  const [Screen, setScreen] = useState<ComponentType<{
    mode: 'request' | 'template';
    request: RuleRequestV1 | null;
    invalidReason: string | null;
    initialAgent?: string;
    firstRun?: boolean;
    onDecline?: () => void;
    onOpened?: (result: OpenMandateResult) => void;
  }> | null>(null);

  useEffect(() => {
    let alive = true;
    void import('../ApprovalScreen').then((mod) => {
      if (alive) {
        setScreen(() => mod.ApprovalScreen);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!Screen) {
    return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
  }
  return (
    <Screen
      mode={props.mode}
      request={props.request}
      invalidReason={null}
      initialAgent={props.initialAgent}
      firstRun
      onDecline={props.onDecline}
      onOpened={props.onOpened}
    />
  );
}

function AlertsGate({
  cluster,
  opened,
  onFinish,
  amountsReady,
}: {
  cluster: string | null;
  opened: OpenMandateResult | null;
  onFinish: () => void;
  amountsReady: boolean;
}) {
  const chain = useChain();
  const [View, setView] = useState<ComponentType<{
    cluster: string | null;
    address: string | null;
    exampleLimit: string | null;
    onNotNow: () => void;
  }> | null>(null);

  useEffect(() => {
    let alive = true;
    void import('./AlertsStage').then((mod) => {
      if (alive) {
        setView(() => mod.AlertsStage);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!View) {
    return <ActivityIndicator color={colors.text} accessibilityLabel="Loading" />;
  }
  return (
    <View
      cluster={cluster}
      address={opened?.mandate.address ?? null}
      exampleLimit={
        amountsReady && opened ? formatBaseUnits(opened.mandate.perTxMax, chain.decimals) : null
      }
      onNotNow={onFinish}
    />
  );
}
