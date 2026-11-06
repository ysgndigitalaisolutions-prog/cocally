/** A first name fit to say out loud, title-cased, or null. */
export function usableFirstName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z][A-Za-z'-]{1,29}$/.test(name)) return null;
  if (/^(mr|mrs|ms|miss|dr|sir|madam|unknown|test|na|n\/a|customer|resident|occupant)$/i.test(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}
