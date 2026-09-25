'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { LuChevronDown, LuChevronRight } from 'react-icons/lu';
import type { SessionUser } from '@/lib/store';
import { roleLabel } from '@/lib/roles';
import { navItemFor, sectionContains, visibleSections, type NavItem, type NavSection } from '@/lib/nav';

const SETUP_OPEN_KEY = 'cocally.nav.setupOpen';

interface Props {
  user: SessionUser;
  pathname: string;
  onLogout: () => void;
}

/**
 * Grouped, role-filtered navigation. Agents get "My desk" and their account;
 * managers get Operate and Setup on top of that. Setup is the only section
 * that collapses, because its pages are visited once a week, not once a call.
 */
export default function Sidebar({ user, pathname, onLogout }: Props) {
  const sections = visibleSections(user);
  const active = navItemFor(pathname);
  const account = sections.find((s) => s.id === 'account');
  const body = sections.filter((s) => s.id !== 'account');

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface p-4">
      <div className="mb-6 px-2 text-xl font-bold">
        Co<span className="text-accent">Cally</span>
      </div>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto">
        {body.map((section) => (
          <Section key={section.id} section={section} pathname={pathname} activeHref={active?.href} />
        ))}
      </nav>
      <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
        {account?.items.map((item) => (
          <NavLink key={item.href} item={item} active={item.href === active?.href} />
        ))}
        <p className="mt-2 truncate px-2 text-sm font-medium">{user.name}</p>
        <p className="truncate px-2 text-xs text-dim">{roleLabel(user)}</p>
        <button onClick={onLogout} className="btn btn-ghost mt-3 w-full text-sm">
          Sign out
        </button>
      </div>
    </aside>
  );
}

function Section({ section, pathname, activeHref }: { section: NavSection; pathname: string; activeHref?: string }) {
  const inside = sectionContains(section, pathname);
  const [open, setOpen] = useState(!section.collapsible);

  // Remembered per browser; a section holding the current page is always open.
  useEffect(() => {
    if (!section.collapsible) return;
    try {
      const stored = localStorage.getItem(SETUP_OPEN_KEY);
      setOpen(inside || stored === '1');
    } catch {
      setOpen(inside);
    }
  }, [section.collapsible, inside]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(SETUP_OPEN_KEY, next ? '1' : '0');
    } catch {
      /* private mode: the chevron still works for this page load */
    }
  }

  const header = (
    <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">{section.label}</span>
  );

  return (
    <div>
      {section.collapsible ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="mb-1 flex w-full items-center justify-between rounded-md px-3 py-1 hover:bg-surface-2"
        >
          {header}
          {open ? <LuChevronDown className="h-3.5 w-3.5 text-dim" /> : <LuChevronRight className="h-3.5 w-3.5 text-dim" />}
        </button>
      ) : (
        <div className="mb-1 px-3 py-1">{header}</div>
      )}
      {open && (
        <div className="flex flex-col gap-0.5">
          {section.items.map((item) => (
            <NavLink key={item.href} item={item} active={item.href === activeHref} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium ${
        active ? 'bg-surface-2 text-accent' : 'text-dim hover:bg-surface-2 hover:text-text'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
