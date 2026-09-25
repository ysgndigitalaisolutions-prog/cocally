import type { IconType } from 'react-icons';
import {
  LuChartLine,
  LuEar,
  LuFileText,
  LuGitBranch,
  LuHash,
  LuHeadset,
  LuLayoutDashboard,
  LuList,
  LuLock,
  LuMegaphone,
  LuPhone,
  LuPhoneCall,
  LuPlug,
  LuRadio,
  LuScrollText,
  LuShield,
  LuUsers,
} from 'react-icons/lu';
import type { Role } from '@cocally/shared';
import { hasRole, type RoleBearer } from './roles';

export interface NavItem {
  href: string;
  label: string;
  icon: IconType;
  roles: Role[];
}

export interface NavSection {
  id: 'desk' | 'operate' | 'setup' | 'account';
  label: string;
  /** Collapsible sections start closed; the others always show their items. */
  collapsible?: boolean;
  items: NavItem[];
}

/**
 * The sidebar, grouped by who uses it. Role lists are the ones the flat nav
 * carried before, except the "My desk" rows, which follow `DESK_ROLES` (see
 * roles.ts for why OWNER is not there). An agent sees My desk + Account only.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'desk',
    label: 'My desk',
    items: [
      { href: '/workspace', label: 'Workspace', icon: LuHeadset, roles: ['AGENT', 'SUPERVISOR', 'ADMIN'] },
      { href: '/manual-dial', label: 'Manual dial', icon: LuPhone, roles: ['AGENT', 'SUPERVISOR', 'ADMIN'] },
      { href: '/insights', label: 'My insights', icon: LuChartLine, roles: ['AGENT', 'SUPERVISOR', 'ADMIN'] },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LuLayoutDashboard, roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
      { href: '/supervisor', label: 'Supervisor desk', icon: LuEar, roles: ['SUPERVISOR', 'ADMIN', 'OWNER'] },
      { href: '/team', label: 'Team insights', icon: LuUsers, roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
      { href: '/campaigns', label: 'Campaigns', icon: LuMegaphone, roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
      { href: '/leads', label: 'Leads', icon: LuList, roles: ['OWNER', 'ADMIN', 'SUPERVISOR'] },
      { href: '/calls', label: 'Calls', icon: LuPhoneCall, roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
      { href: '/reports', label: 'Reports', icon: LuFileText, roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'QA'] },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    collapsible: true,
    items: [
      { href: '/flows', label: 'Flows', icon: LuGitBranch, roles: ['OWNER', 'ADMIN', 'SUPERVISOR'] },
      { href: '/cli-numbers', label: 'CLI numbers', icon: LuHash, roles: ['OWNER', 'ADMIN', 'SUPERVISOR'] },
      { href: '/providers', label: 'Providers', icon: LuPlug, roles: ['OWNER', 'ADMIN'] },
      { href: '/users', label: 'Users & access', icon: LuShield, roles: ['OWNER', 'ADMIN'] },
      { href: '/audit', label: 'Audit log', icon: LuScrollText, roles: ['OWNER', 'ADMIN', 'QA'] },
      // Dev-only: places a real PSTN call outside every compliance gate.
      ...(process.env.NODE_ENV === 'production'
        ? []
        : [{ href: '/live-demo', label: 'Live demo', icon: LuRadio, roles: ['OWNER', 'ADMIN'] as Role[] }]),
    ],
  },
  {
    id: 'account',
    label: 'Account',
    // Every role, API_CLIENT included: this is the fallback home, so it must
    // never be a page `canVisit` rejects or the guard would loop.
    items: [
      { href: '/security', label: 'My security', icon: LuLock, roles: ['OWNER', 'ADMIN', 'SUPERVISOR', 'AGENT', 'QA', 'API_CLIENT'] },
    ],
  },
];

const ALL_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Sections with only the items this user may open; empty sections are dropped. */
export function visibleSections(user: RoleBearer): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => hasRole(user, ...item.roles)),
  })).filter((section) => section.items.length > 0);
}

function matches(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

/** The nav item that owns a path, e.g. `/team/abc` belongs to Team insights. */
export function navItemFor(pathname: string): NavItem | undefined {
  return ALL_ITEMS.filter((item) => matches(item.href, pathname)).sort((a, b) => b.href.length - a.href.length)[0];
}

/** Paths outside the nav (e.g. `/demo/...`) are not this guard's business. */
export function canVisit(user: RoleBearer, pathname: string): boolean {
  const item = navItemFor(pathname);
  return !item || hasRole(user, ...item.roles);
}

/** True when `pathname` is inside one of the section's items. */
export function sectionContains(section: NavSection, pathname: string): boolean {
  return section.items.some((item) => matches(item.href, pathname));
}
