import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { ApprovalScreen } from '../components/ApprovalScreen';
import { parseRuleRequest, ruleRequestFromParams } from '../lib/ruleRequest';

export default function RuleRequestRoute() {
  const params = useLocalSearchParams();
  const parsed = useMemo(() => {
    const raw = params.url;
    const url = Array.isArray(raw) ? raw[0] : raw;
    if (typeof url === 'string' && url.length > 0) {
      return parseRuleRequest(url);
    }
    const fields: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' || Array.isArray(value)) {
        fields[key] = value;
      }
    }
    return ruleRequestFromParams(fields);
  }, [params]);

  if (!parsed.ok) {
    return <ApprovalScreen mode="request" request={null} invalidReason={parsed.reason} />;
  }
  return <ApprovalScreen mode="request" request={parsed.request} invalidReason={null} />;
}
