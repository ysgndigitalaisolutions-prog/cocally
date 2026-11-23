import { describe, expect, it } from 'vitest';
import { pickWorkspaceAccount } from '../workspace-pick';

// One person, two workspaces, same phone (23 Nov: Nithin in YSGN and Call Tap).
const ysgn = (pw: string) => ({ tenantId: 'ysgn', active: true, passwordHash: pw });
const calltap = (pw: string) => ({ tenantId: 'calltap', active: true, passwordHash: pw });
const opens = async (u: { passwordHash?: string; active?: boolean }, pw: string) => Boolean(u.active && u.passwordHash === pw);

describe('sign-in with one phone in two workspaces', () => {
  const same = [ysgn('same'), calltap('same')];
  const different = [ysgn('pw-ysgn'), calltap('pw-calltap')];

  it('asks which workspace when the password opens both', async () => {
    const r = await pickWorkspaceAccount(same, 'same', undefined, opens);
    expect(r.user).toBeNull();
    expect(r.choose?.map((u) => u.tenantId)).toEqual(['ysgn', 'calltap']);
  });

  it('signs in to the workspace picked', async () => {
    expect((await pickWorkspaceAccount(same, 'same', 'calltap', opens)).user?.tenantId).toBe('calltap');
  });

  it('goes straight in when the password opens only one', async () => {
    expect((await pickWorkspaceAccount(different, 'pw-calltap', undefined, opens)).user?.tenantId).toBe('calltap');
    expect((await pickWorkspaceAccount(different, 'pw-ysgn', undefined, opens)).user?.tenantId).toBe('ysgn');
  });

  it('never lands in another workspace than the one asked for', async () => {
    expect((await pickWorkspaceAccount(different, 'pw-calltap', 'ysgn', opens)).user).toBeNull();
    expect((await pickWorkspaceAccount([ysgn('x')], 'x', 'calltap', opens)).user).toBeNull();
  });

  it('a wrong password gives the first account (which then fails) and no list', async () => {
    const r = await pickWorkspaceAccount(same, 'nope', undefined, opens);
    expect(r.choose).toBeUndefined();
    expect(r.user?.tenantId).toBe('ysgn');
  });

  it('a deactivated account is not offered', async () => {
    const r = await pickWorkspaceAccount([ysgn('same'), { ...calltap('same'), active: false }], 'same', undefined, opens);
    expect(r.user?.tenantId).toBe('ysgn');
  });
});
