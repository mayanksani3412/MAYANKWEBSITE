import { connectSupabase } from '../backend/supabase.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#password-reset-form');
const status = $('#reset-status');
const unavailable = $('#reset-unavailable');
const connectionStatus = $('#reset-connection-status');
const markerKey = 'community-password-recovery-user';
let supabase;
let recoveryUserId = null;
let passwordUpdated = false;

function setStatus(message, isError) {
  status.textContent = message;
  status.className = 'form-status ' + (isError ? 'error' : 'success');
}

function showUnavailable(message) {
  form.hidden = true;
  unavailable.hidden = false;
  setStatus(message, true);
  $('#reset-connection-title').textContent = 'Recovery link could not be verified';
  $('#reset-connection-copy').textContent = 'Request a fresh password reset link to continue.';
  connectionStatus.classList.add('error');
}

function rememberRecovery(userId) {
  recoveryUserId = userId;
  try {
    sessionStorage.setItem(markerKey, userId);
  } catch {
    // The verified event remains available for this page session.
  }
}

function clearRecoveryMarker() {
  recoveryUserId = null;
  try {
    sessionStorage.removeItem(markerKey);
  } catch {
    // No password or authentication credential is stored in this marker.
  }
}

async function initialize() {
  try {
    supabase = await connectSupabase();
    supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY' && nextSession && nextSession.user) {
        rememberRecovery(nextSession.user.id);
        form.hidden = false;
        unavailable.hidden = true;
        setStatus('Recovery link verified. Choose a new password.', false);
        $('#reset-connection-title').textContent = 'Recovery link verified';
        $('#reset-connection-copy').textContent = 'Your password can now be updated securely.';
        connectionStatus.classList.add('ready');
        return;
      }
      if (event === 'SIGNED_OUT' && !passwordUpdated) {
        clearRecoveryMarker();
        showUnavailable('Your recovery session ended. Request a new reset link and try again.');
      }
    });

    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const activeSession = data.session;
    if (!activeSession || !activeSession.user) {
      showUnavailable('This recovery link is invalid or expired. Request a new link to continue.');
      return;
    }

    let storedUserId = null;
    try {
      storedUserId = sessionStorage.getItem(markerKey);
    } catch {
      // Session verification can still use the recovery callback in the URL.
    }
    if (storedUserId && storedUserId === activeSession.user.id) {
      recoveryUserId = storedUserId;
    }
    if (recoveryUserId !== activeSession.user.id) {
      showUnavailable('This session was not started from a valid password recovery link.');
      return;
    }

    form.hidden = false;
    unavailable.hidden = true;
    setStatus('Recovery link verified. Choose a new password.', false);
    $('#reset-connection-title').textContent = 'Recovery link verified';
    $('#reset-connection-copy').textContent = 'Your password can now be updated securely.';
    connectionStatus.classList.add('ready');
  } catch {
    showUnavailable('We could not verify this recovery link. Check your connection or request a new link.');
  }
}

$('#show-passwords').addEventListener('change', (event) => {
  const type = event.currentTarget.checked ? 'text' : 'password';
  $('#new-password').type = type;
  $('#confirm-new-password').type = type;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const password = $('#new-password').value;
  const confirmation = $('#confirm-new-password').value;
  if (password.length < 8) {
    setStatus('Your password must be at least 8 characters long.', true);
    return;
  }
  if (password !== confirmation) {
    setStatus('The passwords do not match.', true);
    $('#confirm-new-password').focus();
    return;
  }
  if (!supabase || !recoveryUserId) {
    showUnavailable('Your recovery session is no longer valid. Request a new reset link.');
    return;
  }

  const button = $('#update-password-submit');
  button.disabled = true;
  button.textContent = 'Updating…';
  try {
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (!data.session || data.session.user.id !== recoveryUserId) {
      throw new Error('The recovery session is no longer valid.');
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;

    passwordUpdated = true;
    clearRecoveryMarker();
    form.reset();
    form.hidden = true;
    $('#show-passwords').checked = false;
    setStatus('Your password has been updated. You can now sign in with your new password.', false);
    $('#reset-connection-title').textContent = 'Password updated';
    $('#reset-connection-copy').textContent = 'Use your new password on the Community sign-in page.';
    try {
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      window.location.replace(new URL('community.html?password=updated', window.location.href).href);
    } catch (error) {
      console.error('Password updated, but the recovery session could not be signed out:', error);
      setStatus('Your password was updated, but this browser session could not be signed out. Return to Community, sign out, then sign in with your new password.', true);
    }
  } catch (error) {
    setStatus(error && error.message
      ? error.message
      : 'We could not update your password. Check your connection and try again.', true);
  } finally {
    button.disabled = false;
    button.textContent = 'Update Password';
  }
});

initialize();
