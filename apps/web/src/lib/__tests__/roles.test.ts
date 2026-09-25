import { describe, expect, it } from 'vitest';
import { homeFor, roleLabel } from '@/lib/roles';
import { canVisit, navItemFor, visibleSections } from '@/lib/nav';

const agent = { roles: ['AGENT'] };
const owner = { roles: ['OWNER'] };
const ownerTakesCalls = { roles: ['OWNER', 'ADMIN', 'AGENT'] };
const supervisor = { roles: ['SUPERVISOR'] };
const qa = { roles: ['QA'] };

describe('homeFor', () => {
  it('sends anyone holding AGENT to the workspace', () => {
    expect(homeFor(agent)).toBe('/workspace');
    expect(homeFor(ownerTakesCalls)).toBe('/workspace');
  });
  it('sends managers to the dashboard', () => {
    expect(homeFor(owner)).toBe('/dashboard');
    expect(homeFor(supervisor)).toBe('/dashboard');
    expect(homeFor(qa)).toBe('/dashboard');
  });
  it('sends privileged users to security until 2FA is set up', () => {
    expect(homeFor({ roles: ['OWNER'], twoFactorSetupRequired: true })).toBe('/security');
  });
  it('never returns a page the same user cannot visit', () => {
    for (const u of [agent, owner, ownerTakesCalls, supervisor, qa, { roles: ['API_CLIENT'] }]) {
      expect(canVisit(u, homeFor(u))).toBe(true);
    }
  });
});

describe('visibleSections', () => {
  it('gives an agent only My desk and Account', () => {
    const ids = visibleSections(agent).map((s) => s.id);
    expect(ids).toEqual(['desk', 'account']);
    expect(visibleSections(agent).find((s) => s.id === 'desk')?.items.map((i) => i.label)).toEqual([
      'Workspace',
      'Manual dial',
      'My insights',
    ]);
  });
  it('hides My desk from an owner who does not take calls', () => {
    expect(visibleSections(owner).map((s) => s.id)).toEqual(['operate', 'setup', 'account']);
  });
  it('shows My desk once the owner takes calls', () => {
    expect(visibleSections(ownerTakesCalls).map((s) => s.id)).toEqual(['desk', 'operate', 'setup', 'account']);
  });
  it('drops a section with no visible items', () => {
    const qaSections = visibleSections(qa);
    expect(qaSections.find((s) => s.id === 'desk')).toBeUndefined();
    expect(qaSections.find((s) => s.id === 'setup')?.items.map((i) => i.label)).toEqual(['Audit log']);
  });
});

describe('canVisit / navItemFor', () => {
  it('bounces an agent off management pages', () => {
    expect(canVisit(agent, '/dashboard')).toBe(false);
    expect(canVisit(agent, '/users')).toBe(false);
    expect(canVisit(agent, '/workspace')).toBe(true);
    expect(canVisit(agent, '/security')).toBe(true);
  });
  it('bounces QA off the workspace', () => {
    expect(canVisit(qa, '/workspace')).toBe(false);
  });
  it('treats nested routes as their section item', () => {
    expect(navItemFor('/team/abc')?.label).toBe('Team insights');
    expect(navItemFor('/campaigns/123')?.label).toBe('Campaigns');
    expect(canVisit(qa, '/team/abc')).toBe(true);
    expect(canVisit(agent, '/campaigns/123')).toBe(false);
  });
  it('ignores paths outside the nav', () => {
    expect(navItemFor('/demo/lead/x')).toBeUndefined();
    expect(canVisit(agent, '/demo/lead/x')).toBe(true);
  });
});

describe('roleLabel', () => {
  it('names the most senior role', () => {
    expect(roleLabel(owner)).toBe('Owner');
    expect(roleLabel({ roles: ['SUPERVISOR', 'QA'] })).toBe('Supervisor');
    expect(roleLabel(agent)).toBe('Agent');
  });
  it('flags a non-agent who also takes calls', () => {
    expect(roleLabel(ownerTakesCalls)).toBe('Owner · takes calls');
    expect(roleLabel({ roles: ['SUPERVISOR', 'AGENT'] })).toBe('Supervisor · takes calls');
  });
});
