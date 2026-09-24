// The Help control is hidden on /help and /onboarding, so the flow cannot
// push /help onto itself. Next and the introduction push. Back pops, which
// is also what the system back does, so both land on the same screen.
// From Rules the stack is at most [rules, help, refusal, export].

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

// The page under this route after Next or "Show the introduction" pushes.
// A pop, from the on-screen Back or the system back, reveals it.
export function helpFlowBackTarget(pathname: string): string | null {
  return BACK_TARGET[routePath(pathname)] ?? null;
}
