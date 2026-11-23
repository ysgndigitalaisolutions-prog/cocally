/**
 * Which account a sign-in opens, when one phone has accounts in several
 * workspaces (tenants). 23 Nov: Nithin in YSGN and in Call Tap, same phone.
 *
 * - One account: that one (the usual checks then pass or fail it).
 * - Several: those the password opens are the choice. A `tenantId` picks one of
 *   them; with no `tenantId`, one that opens is used, and two or more are
 *   returned as `choose` for the person to pick from.
 * - A `tenantId` the password does not open is never swapped for another.
 * - Wrong password everywhere: the first account, which then fails on it.
 */
export interface PickableAccount {
  tenantId: { toString(): string };
  active?: boolean;
  passwordHash?: string;
}

export async function pickWorkspaceAccount<U extends PickableAccount>(
  candidates: U[],
  password: string,
  tenantId: string | undefined,
  opens: (u: U, password: string) => Promise<boolean>,
): Promise<{ user: U | null; choose?: U[] }> {
  if (candidates.length <= 1) {
    const only = candidates[0] ?? null;
    if (tenantId && only && only.tenantId.toString() !== tenantId) return { user: null };
    return { user: only };
  }
  const open: U[] = [];
  for (const u of candidates) if (await opens(u, password)) open.push(u);
  if (tenantId) return { user: open.find((u) => u.tenantId.toString() === tenantId) ?? null };
  if (open.length === 1) return { user: open[0]! };
  if (open.length > 1) return { user: null, choose: open };
  return { user: candidates[0]! };
}
