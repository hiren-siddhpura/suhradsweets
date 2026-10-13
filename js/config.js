export const APP_NAME = 'Suhrad Sweets OMS';

export const PAGES = Object.freeze({
  dashboard: { title: 'Dashboard', description: 'He Hari ! Bas Ek Tu Raji Tha' },
  orders: { title: 'Orders', description: 'Create, confirm and track customer orders.' },
  specials: { title: 'Special Products', description: 'Set combination recipes and final selling prices.' },
  customers: { title: 'Customers', description: 'Customer access will follow each user’s linked orders.' },
  inventory: { title: 'Inventory', description: 'Stock balances, low-stock controls and movement history.' },
  purchases: { title: 'Purchases', description: 'Draft, confirm and review supplier purchases.' },
  invoices: { title: 'Invoices', description: 'Review manually created invoices, balances and PDFs.' },
  payments: { title: 'Payments', description: 'Submit, verify and audit invoice payments.' },
  targets: { title: 'Users & Targets', description: 'Track eligible sales against daily, weekly and monthly goals.' },
  announcements: { title: 'Announcements', description: 'Publish and expire team updates.' },
  loginLogs: { title: 'Login Logs', description: 'Review recorded sign-ins and application sign-outs.' },
  auditLogs: { title: 'Audit Logs', description: 'Review trusted operational and financial actions.' },
  master: { title: 'Master Data', description: 'Manage items, purchase types, user profiles and settings.' },
});

export const ROLE_LABELS = Object.freeze({
  admin: 'Admin',
  account_admin: 'Account Admin',
  user: 'User',
});
