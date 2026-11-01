const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

export function userDisplayName(user) {
  return [user?.displayName, user?.fullName, user?.name].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

export function sortUsersByName(rows, getName = userDisplayName) {
  return [...rows].sort((left, right) => {
    const a = String(getName(left) || '').trim();
    const b = String(getName(right) || '').trim();
    if (!a || !b) return a ? -1 : b ? 1 : 0;
    return collator.compare(a, b) || collator.compare(String(left?.id || ''), String(right?.id || ''));
  });
}
