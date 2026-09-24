// Help, its three pages, and the introduction share one stack slot.
// Entering from anywhere else pushes. Moving inside the flow replaces.

const HELP = '/help';
const ONBOARDING = '/onboarding';

const BACK_TARGET: Record<string, string> = {
  '/help/refusal': HELP,
  '/help/export': '/help/refusal',
  [ONBOARDING]: HELP,
};

export function routePath(pathname: string): string {
  const bare = (pathname.split('?')[0] ?? pathname).trim();
  if (bare.length > 1 && bare.endsWith('/')) return bare.slice(0, -1);
  return bare || '/';
}

export function isHelpOrOnboarding(pathname: string): boolean {
  const path = routePath(pathname);
  return path === HELP || path.startsWith(`${HELP}/`) || path === ONBOARDING;
}

export function showHelpControl(help: boolean, pathname: string): boolean {
  return help && !isHelpOrOnboarding(pathname);
}

export function helpFlowBackTarget(pathname: string): string | null {
  return BACK_TARGET[routePath(pathname)] ?? null;
}

type HelpRouter = {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
};

export function openHelp(router: Pick<HelpRouter, 'push' | 'replace'>, pathname: string): void {
  if (isHelpOrOnboarding(pathname)) router.replace(HELP);
  else router.push(HELP);
}

export function leaveHelpOrOnboarding(router: Pick<HelpRouter, 'replace' | 'back'>, pathname: string): void {
  const target = helpFlowBackTarget(pathname);
  if (target) router.replace(target);
  else router.back();
}
