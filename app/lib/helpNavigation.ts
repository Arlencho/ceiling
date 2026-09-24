// The Help control is hidden on /help and /onboarding, so the flow cannot
// push /help onto itself. Next and the introduction push. Back pops, which
// is also what the system back does, so both land on the same screen.
// Done dismisses the contiguous /help, /help/refusal, and /help/export routes
// on top of the stack and leaves whatever was open beneath them.
// A stack pop keeps at least one route, so when nothing is beneath those
// pages Done replaces the remaining page with the tabs home.

const HELP = '/help';
const HELP_REFUSAL = '/help/refusal';
const HELP_EXPORT = '/help/export';
const TABS_HOME = '/(tabs)';

const HELP_FLOW = new Set([HELP, HELP_REFUSAL, HELP_EXPORT]);

const ONBOARDING = '/onboarding';

const BACK_TARGET: Record<string, string> = {
  [HELP_REFUSAL]: HELP,
  [HELP_EXPORT]: HELP_REFUSAL,
  [ONBOARDING]: HELP,
};

export type HelpStackRoute = {
  name?: string;
  path?: string;
};

export type HelpStackEntry = string | HelpStackRoute;

type HelpDoneRouter = {
  canDismiss: () => boolean;
  dismiss: (count?: number) => void;
  replace: (href: string) => void;
};

type HelpPushRouter = {
  push: (href: string) => void;
  replace: (href: string) => void;
};

export function routePath(pathname: string): string {
  const bare = (pathname.split('?')[0] ?? pathname).trim();
  if (bare.length > 1 && bare.endsWith('/')) return bare.slice(0, -1);
  return bare || '/';
}

function helpFlowPath(value: string): string {
  const path = routePath(value.startsWith('/') ? value : `/${value}`);
  return path === '/help/index' ? HELP : path;
}

export function isHelpFlowRoute(route: HelpStackEntry): boolean {
  if (typeof route === 'string') return HELP_FLOW.has(helpFlowPath(route));
  if (typeof route.path === 'string' && HELP_FLOW.has(helpFlowPath(route.path))) return true;
  if (typeof route.name === 'string' && HELP_FLOW.has(helpFlowPath(route.name))) return true;
  return false;
}

// How many /help, /help/refusal, and /help/export routes sit contiguously
// at the top of this route list.
export function helpRoutesOnTop(routes: readonly HelpStackEntry[]): number {
  let count = 0;
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    if (!isHelpFlowRoute(routes[index] ?? '')) break;
    count += 1;
  }
  return count;
}

function dismissCountedHelp(router: HelpDoneRouter, routes: readonly HelpStackEntry[]): void {
  const count = helpRoutesOnTop(routes);
  if (count === 0) return;
  const beneath = routes.length - count;
  if (beneath === 0) {
    // Popping the only route is not handled. Pop the pages above it, then
    // replace the one that remains.
    if (count > 1) router.dismiss(count);
    router.replace(TABS_HOME);
    return;
  }
  router.dismiss(count);
}

// Used when the route list is not available. Dismiss one help route at a time
// until the focused route is not a help page, then replace if that last page
// is still a help page (nothing was beneath it).
function dismissHelpByFocusedPath(router: HelpDoneRouter, readPath: () => string): void {
  let path = readPath();
  let guard = 0;
  while (isHelpFlowRoute(path) && router.canDismiss() && guard < 8) {
    router.dismiss(1);
    const next = readPath();
    guard += 1;
    if (next === path) break;
    path = next;
  }
  if (isHelpFlowRoute(path)) router.replace(TABS_HOME);
}

function pathReaderWorks(readPath: () => string): boolean {
  try {
    return typeof readPath() === 'string';
  } catch {
    return false;
  }
}

export function finishHelpExport(
  router: HelpDoneRouter,
  routes?: readonly HelpStackEntry[] | null,
  readPath?: () => string,
): void {
  if (routes && routes.length > 0) {
    dismissCountedHelp(router, routes);
    return;
  }
  if (readPath && pathReaderWorks(readPath)) {
    dismissHelpByFocusedPath(router, readPath);
    return;
  }
  router.replace(TABS_HOME);
}

// The refusal page is pushed onto /help. When the focused route is the tabs
// home, put /help back first so the push does not cover that home directly.
export function openHelpRefusal(router: HelpPushRouter, pathname: string): void {
  if (routePath(pathname) === TABS_HOME) router.replace(HELP);
  router.push(HELP_REFUSAL);
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
