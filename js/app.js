import { clearLoginError, initUi, setStatus, showAccessDenied, showError, showLoading, showLoginError, showSetup, showSignedIn, showSignedOut, showToast } from './ui.js';
import { validateProfile } from './permissions.js';
import { firebaseErrorCode, profileReadErrorMessage } from './profile-error.js';
import { initPasswordVisibilityToggle } from './password-visibility.js';
import { initPwa } from './pwa.js';
import { startLoading, stopLoading } from './loading.js';
import { initMobileToolbars } from './mobile-toolbar.js';

// Diagnostic fields are limited to mode, public project ID, category and Firebase error code.
// Never log Auth users, profile data, passwords, credentials or raw Firebase error objects.
function authDiagnostic(category, services, error = null) {
  const details = { category, mode: services?.mode || 'uninitialized', projectId: services?.app?.options?.projectId || 'unavailable' };
  if (error) details.code = firebaseErrorCode(error);
  console.info('[OMS authentication]', details);
}

function loginMessage(error) {
  switch (error.code) {
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Email or password is incorrect.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a while, then try again.';
    case 'auth/network-request-failed': return 'Network connection failed. Check your connection and try again.';
    case 'auth/operation-not-allowed': return 'Email/password sign-in is not enabled for this Firebase project.';
    case 'auth/unauthorized-domain': return 'This site is not an authorized sign-in domain in Firebase.';
    default: return 'Sign-in failed. Check your details and try again.';
  }
}

function accessMessage(reason) {
  if (reason === 'missing') return 'Your Firebase account has no OMS profile. Ask an administrator to create one.';
  if (reason === 'inactive') return 'Your OMS profile is inactive. Contact an administrator.';
  return 'Your OMS profile has an invalid role. Contact an administrator.';
}

initUi();
initPwa();
initPasswordVisibilityToggle();
showLoading();

try {
  const [{ initializeFirebase }, { observeAuth, signIn, signOutUser }, { observeUserProfile, recordAuthEvent }, { initMasterData }, { initOperationsUi }, { initOrderUi }, { initFinanceUi }, { initReportingUi }, { configureOperations }, { initCustomerImport }, { initBoxReq }, { initOrderAnalytics }, { initCollectionsUi }] = await Promise.all([
    import('./firebase-config.js'), import('./auth.js'), import('./data.js'), import('./master-ui.js'), import('./operations-ui.js'), import('./order-ui.js?v=orders-mobile-20261029'), import('./finance-ui.js'), import('./reporting-ui.js'), import('./operations-data.js'), import('./customer-import-ui.js'), import('./box-req-ui.js'), import('./order-analytics-ui.js'), import('./collections-ui.js'),
  ]);
  const services = initializeFirebase();
  if (!services) {
    authDiagnostic('firebase-configuration-missing', null);
    showSetup();
  } else {
    configureOperations(services.functions, services.mode);
    document.getElementById('emulator-banner').hidden = services.mode !== 'emulator';
    const emulatorMode = services.mode === 'emulator';
    const sameProject = services.auth.app === services.db.app
      && services.auth.app.options.projectId === services.db.app.options.projectId;
    authDiagnostic(sameProject ? 'services-initialized' : 'firebase-configuration-mismatch', services);
    const master = initMasterData(services);
    const operations = initOperationsUi(services);
    const orders = initOrderUi(services);
    const customerImport = initCustomerImport(services);
    const finance = initFinanceUi(services);
    const collections = initCollectionsUi(services);
    const reporting = initReportingUi(services);
    const boxReq = initBoxReq(services);
    const orderAnalytics = initOrderAnalytics(services);
    initMobileToolbars();
    let authRevision = 0;
    let stopProfile = null;
    let profileTimer = null;
    const authStartupTimer = setTimeout(() => showError('Sign-in state is taking too long to load. Check your connection and reload.'), 20000);
    observeAuth(services.auth, (user) => {
      clearTimeout(authStartupTimer);
      const revision = ++authRevision;
      clearTimeout(profileTimer);
      if (stopProfile) { stopProfile(); stopProfile = null; }
      if (!user) { authDiagnostic('no-authenticated-user', services); master.setSession(null, null); operations.setSession(null, null); orders.setSession(null, null); customerImport.setSession(null, null); finance.setSession(null, null); collections.setSession(null, null); reporting.setSession(null, null); boxReq.setSession(null, null); orderAnalytics.setSession(null, null); showSignedOut(); return; }
      if (!sameProject) {
        authDiagnostic('firebase-configuration-mismatch', services);
        showAccessDenied(user, 'Authentication and Firestore are configured for different Firebase projects. Check the web configuration.');
        return;
      }
      authDiagnostic('profile-read-started', services);
      showLoading('Loading your account profile.');
      profileTimer = setTimeout(() => {
        if (revision === authRevision) showError('Account verification is taking too long. Check your connection and reload.');
      }, 20000);
      stopProfile = observeUserProfile(services.db, user.uid, (profile, fromCache) => {
        if (revision !== authRevision) return;
        if (fromCache) {
          master.setSession(null, null);
          operations.setSession(null, null);
          orders.setSession(null, null);
          customerImport.setSession(null, null);
          finance.setSession(null, null); collections.setSession(null, null);
          reporting.setSession(null, null);
          boxReq.setSession(null, null);
          orderAnalytics.setSession(null, null);
          showLoading('Verifying your account with Firestore.');
          return;
        }
        clearTimeout(profileTimer);
        const reason = validateProfile(profile);
        if (reason) authDiagnostic(reason === 'missing' ? 'user-document-missing' : reason === 'inactive' ? 'user-account-inactive' : 'user-role-or-profile-invalid', services);
        else authDiagnostic('user-profile-verified', services);
        if (reason) { master.setSession(null, null); operations.setSession(null, null); orders.setSession(null, null); customerImport.setSession(null, null); finance.setSession(null, null); collections.setSession(null, null); reporting.setSession(null, null); boxReq.setSession(null, null); orderAnalytics.setSession(null, null); showAccessDenied(user, accessMessage(reason)); }
        else { boxReq.setSession(user, profile); showSignedIn(user, profile); master.setSession(user, profile); operations.setSession(user, profile); orders.setSession(user, profile); customerImport.setSession(user, profile); finance.setSession(user, profile); collections.setSession(user, profile); reporting.setSession(user, profile); orderAnalytics.setSession(user, profile); }
      }, (error) => {
        clearTimeout(profileTimer);
        authDiagnostic(firebaseErrorCode(error) === 'permission-denied' ? 'profile-read-permission-denied' : ['unavailable', 'deadline-exceeded'].includes(firebaseErrorCode(error)) ? 'profile-read-network-error' : 'profile-read-firebase-error', services, error);
        if (revision === authRevision) {
          master.setSession(null, null);
          operations.setSession(null, null);
          orders.setSession(null, null);
          customerImport.setSession(null, null);
          finance.setSession(null, null); collections.setSession(null, null);
          reporting.setSession(null, null);
          boxReq.setSession(null, null);
          orderAnalytics.setSession(null, null);
          showAccessDenied(user, profileReadErrorMessage(error, emulatorMode));
        }
      });
    }, (error) => { clearTimeout(authStartupTimer); clearTimeout(profileTimer); authDiagnostic('auth-state-error', services, error); showError('Authentication could not start. Check the browser console diagnostic code and your connection.'); });

    document.getElementById('sign-in-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('sign-in-button');
      const form = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      const loadingToken = startLoading('Signing in…');
      button.textContent = 'Signing in…';
      clearLoginError();
      try {
        const email = form.elements.namedItem('email').value.trim();
        const password = form.elements.namedItem('password').value;
        const credential = await signIn(services.auth, email, password);
        form.reset();
        authDiagnostic('login-log-write-started', services);
        try { await recordAuthEvent(services.db, credential.user.uid, 'login'); authDiagnostic('login-log-write-succeeded', services); }
        catch (error) {
          authDiagnostic('login-log-write-failed', services, error);
          showToast('Login activity could not be recorded. Profile access is checked separately.', 'toast-error');
        }
      } catch (error) {
        authDiagnostic('sign-in-failed', services, error);
        showLoginError(loginMessage(error));
      } finally {
        stopLoading(loadingToken);
        button.disabled = false;
        button.textContent = 'Sign in';
      }
    });
    document.getElementById('mobile-sign-out-button').addEventListener('click', () => document.getElementById('sign-out-button').click());
    document.getElementById('sign-out-button').addEventListener('click', async () => {
      const button = document.getElementById('sign-out-button');
      if (button.disabled) return;
      button.disabled = true;
      const loadingToken = startLoading('Signing out…');
      try {
      const user = services.auth.currentUser;
      if (user) {
        authDiagnostic('logout-log-write-started', services);
        try { await recordAuthEvent(services.db, user.uid, 'logout'); authDiagnostic('logout-log-write-succeeded', services); }
        catch (error) {
          authDiagnostic('logout-log-write-failed', services, error);
          showToast('Logout event could not be recorded.', 'toast-error');
        }
      }
      try { await signOutUser(services.auth); }
      catch (error) { authDiagnostic('sign-out-failed', services, error); showToast('Sign-out failed. Check your connection and try again.', 'toast-error'); }
      } finally { stopLoading(loadingToken); button.disabled = false; }
    });
  }
} catch (error) {
  authDiagnostic('firebase-initialization-error', null, error);
  showError(error?.code === 'local-emulator-required'
    ? 'This LAN address is for local emulator testing only. Open the OMS development server without ?firebase=live.'
    : 'The app could not start. Reload the page and check your connection.');
  setStatus('Unavailable', 'status-error');
}
