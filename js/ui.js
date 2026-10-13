import { PAGES, ROLE_LABELS } from './config.js';
import { canAccessPage, profileName } from './permissions.js';

const byId = (id) => document.getElementById(id);
const setHidden = (id, hidden) => { byId(id).hidden = hidden; };

export function setStatus(label, tone = '') {
  const badge = byId('connection-badge');
  badge.textContent = label;
  badge.className = `status-pill ${tone}`.trim();
}

export function showLoading(message = 'Checking Firebase and your sign-in state.') {
  byId('loading-panel').querySelector('p').textContent = message;
  setHidden('loading-panel', false);
  setHidden('error-panel', true);
  setHidden('access-panel', true);
  setHidden('workspace-content', true);
}

export function showSetup() {
  setHidden('loading-panel', true);
  setHidden('setup-panel', false);
  setHidden('auth-panel', true);
  setHidden('workspace-content', true);
  setHidden('access-panel', true);
  setStatus('Setup needed', 'status-warning');
}

export function showError(message) {
  byId('error-message').textContent = message;
  setHidden('error-panel', false);
  setHidden('loading-panel', true);
  setStatus('Needs attention', 'status-error');
}

export function showSignedOut() {
  setHidden('loading-panel', true);
  setHidden('error-panel', true);
  setHidden('setup-panel', true);
  setHidden('access-panel', true);
  setHidden('auth-panel', false);
  setHidden('workspace-content', true);
  setHidden('user-summary', true);
  setHidden('sign-out-button', true);
  applyNavigation(null);
  clearLoginError();
  setStatus('Signed out');
}

function showIdentity(user, profile = null) {
  const name = profileName(profile, user);
  const role = ROLE_LABELS[profile?.role] || 'Role unavailable';
  byId('user-name').textContent = name;
  byId('user-role').textContent = role;
  byId('user-initials').textContent = name.trim().charAt(0).toUpperCase() || '?';
  setHidden('user-summary', false);
  setHidden('sign-out-button', false);
}

export function showAccessDenied(user, reason) {
  showIdentity(user);
  byId('access-message').textContent = reason;
  setHidden('access-panel', false);
  setHidden('auth-panel', true);
  setHidden('loading-panel', true);
  setHidden('error-panel', true);
  setHidden('workspace-content', true);
  applyNavigation(null);
  setStatus('Access denied', 'status-error');
}

export function showSignedIn(user, profile) {
  showIdentity(user, profile);
  setHidden('auth-panel', true);
  setHidden('loading-panel', true);
  setHidden('setup-panel', true);
  setHidden('access-panel', true);
  setHidden('error-panel', true);
  setHidden('workspace-content', false);
  applyNavigation(profile);
  setStatus('Connected', 'status-success');
}

export function showLoginError(message) {
  byId('login-error').textContent = message;
  setHidden('login-error', false);
}

export function clearLoginError() {
  byId('login-error').textContent = '';
  setHidden('login-error', true);
}

function applyNavigation(profile) {
  document.querySelectorAll('[data-page]').forEach((item) => {
    item.hidden = !canAccessPage(profile, item.dataset.page);
  });
  const selected = document.querySelector('[data-page].is-active');
  if (!selected || selected.hidden) {
    const dashboard = document.querySelector('[data-page="dashboard"]');
    if (!dashboard.hidden) dashboard.click();
  }
}

export function showToast(message, tone = '') {
  const toast = document.createElement('div');
  toast.className = `toast ${tone}`.trim();
  toast.textContent = message;
  byId('toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

export function initUi() {
  const menu = byId('menu-button');
  const scrim = byId('mobile-scrim');
  const closeMenu = () => {
    byId('sidebar').classList.remove('is-open');
    scrim.hidden = true;
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open menu');
  };
  menu.addEventListener('click', () => {
    const open = byId('sidebar').classList.toggle('is-open');
    scrim.hidden = !open;
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  scrim.addEventListener('click', closeMenu);
  document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
    const page = button.dataset.page;
    const details = PAGES[page];
    if (!details || button.hidden) return;
    document.querySelectorAll('[data-page]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    byId('page-heading').textContent = page === 'dashboard' ? 'Welcome to Suhrad Sweets' : details.title;
    byId('page-description').textContent = details.description;
    setHidden('dashboard-view', page !== 'dashboard');
    setHidden('feature-view', ['dashboard', 'master', 'inventory', 'purchases', 'orders', 'customers', 'specials', 'invoices', 'payments', 'targets', 'announcements', 'loginLogs', 'auditLogs'].includes(page));
    setHidden('master-view', page !== 'master');
    setHidden('inventory-view', page !== 'inventory');
    setHidden('purchases-view', page !== 'purchases');
    setHidden('orders-view', page !== 'orders');
    setHidden('customers-view', page !== 'customers');
    setHidden('specials-view', page !== 'specials');
    setHidden('invoices-view', page !== 'invoices');
    setHidden('payments-view', page !== 'payments');
    setHidden('targets-view', page !== 'targets');
    setHidden('announcements-view', page !== 'announcements');
    setHidden('loginLogs-view', page !== 'loginLogs');
    setHidden('auditLogs-view', page !== 'auditLogs');
    byId('feature-heading').textContent = `${details.title} is coming next`;
    byId('feature-description').textContent = details.description;
    closeMenu();
    document.dispatchEvent(new CustomEvent('oms:pagechange', { detail: { page } }));
  }));
}
