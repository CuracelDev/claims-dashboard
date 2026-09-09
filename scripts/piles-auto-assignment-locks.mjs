export function canonicalInsurerLockKey(value) {
  const label = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (label === 'uapom' || label === 'old mutual') return 'OLD MUTUAL';
  return label;
}

export function insurerAdvisoryLockName(value) {
  return `piles-insurer:${canonicalInsurerLockKey(value)}`;
}
