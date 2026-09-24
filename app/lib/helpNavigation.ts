// The Help control is hidden on /help and /onboarding, so the flow cannot
// push /help onto itself. Next and the introduction push. Back pops, which
// is also what the system back does, so both land on the same screen.
// From Rules the stack is at most [rules, help, refusal, export].
// Done dismisses those three routes, back to the screen that opened Help.
// A cold veto://help/export link is the only route, so there is nothing
// to dismiss and Done replaces that page with the tabs home.

const HELP = '/help';

// /help, /help/refusal, and /help/export, pushed above the opener.
export const HELP_FLOW_DEPTH = 3;
const TABS_HOME = '/(tabs)';

type HelpDoneRouter = {
  canDismiss: () => boolean;
  dismiss: (count?: number) => void;
  replace: (href: string) => void;
};

// Dismiss the help routes this flow pushed. When the export page is the only
// route, a pop is not handled, so replace it with the tabs home instead.
export function finishHelpExport(router: HelpDoneRouter): void {
  if (router.canDismiss()) {
    router.dismiss(HELP_FLOW_DEPTH);
    return;
  }
  router.replace(TABS_HOME);
}

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
