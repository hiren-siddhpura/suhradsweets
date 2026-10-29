export const ROLES = Object.freeze({
  ADMIN: 'admin',
  ACCOUNT_ADMIN: 'account_admin',
  USER: 'user',
});

const validRoles = new Set(Object.values(ROLES));
const staffRoles = new Set([ROLES.ADMIN, ROLES.ACCOUNT_ADMIN]);
const userPages = new Set(['dashboard', 'orders', 'orderAnalytics', 'customers', 'invoices', 'payments']);
const staffPermissions = new Set(['manageMaster', 'manageStock', 'manageTargets', 'manageAnnouncements', 'manageUsers', 'verifyPayments', 'systemSettings', 'specialOrders']);

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') return 'missing';
  if (profile.active !== true) return 'inactive';
  if (!validRoles.has(profile.role)) return 'invalid';
  if (Object.hasOwn(profile, 'displayName') && typeof profile.displayName !== 'string') return 'invalid';
  if (Object.hasOwn(profile, 'fullName') && typeof profile.fullName !== 'string') return 'invalid';
  return null;
}

export function profileName(profile, authUser = null) {
  const name = [profile?.displayName, profile?.fullName, authUser?.displayName, authUser?.email]
    .find((value) => typeof value === 'string' && value.trim());
  return name?.trim() || 'Signed-in user';
}

export function isStaff(profile) {
  return !validateProfile(profile) && staffRoles.has(profile.role);
}

export function hasPermission(profile, permission) {
  return isStaff(profile) && staffPermissions.has(permission);
}

export function canAccessPage(profile, page) {
  if (validateProfile(profile)) return false;
  return isStaff(profile) || userPages.has(page);
}

export function canPerform(profile, action, record = null, uid = null) {
  if (validateProfile(profile)) return false;
  if (action === 'markInvoicePaid') return profile.role === ROLES.ACCOUNT_ADMIN;
  if (action === 'manageOperations') return isStaff(profile);
  if (action === 'readOwnRecord') return isStaff(profile) || Boolean(uid && record?.ownerUid === uid);
  return false;
}
