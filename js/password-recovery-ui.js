(function () {
  const authForm = document.querySelector('#auth-form');
  const authTabs = document.querySelector('#auth-tabs');
  const forgotPasswordButton = document.querySelector('#forgot-password-link');
  const recoveryForm = document.querySelector('#password-recovery-form');
  const recoveryEmail = document.querySelector('#recovery-email');
  const recoveryStatus = document.querySelector('#recovery-status');
  const backToSignInButton = document.querySelector('#back-to-signin');
  const sendResetButton = document.querySelector('#send-reset-submit');

  function setRecoveryMessage(message, isError) {
    recoveryStatus.textContent = message;
    recoveryStatus.className = 'form-status ' + (isError ? 'error' : 'success');
  }

  if (!authForm || !authTabs || !forgotPasswordButton || !recoveryForm ||
      !recoveryEmail || !recoveryStatus || !backToSignInButton || !sendResetButton) return;

  let waitingForHandler = false;
  let handlerTimeout;
  forgotPasswordButton.addEventListener('click', () => {
    recoveryEmail.value = authForm.elements.email.value.trim();
    authForm.hidden = true;
    authTabs.hidden = true;
    recoveryForm.hidden = false;
    forgotPasswordButton.setAttribute('aria-expanded', 'true');
    setRecoveryMessage('Enter your email and select Send Reset Link.', false);
    recoveryEmail.focus();
    recoveryForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  backToSignInButton.addEventListener('click', () => {
    recoveryForm.hidden = true;
    authTabs.hidden = false;
    authForm.hidden = false;
    forgotPasswordButton.setAttribute('aria-expanded', 'false');
    recoveryEmail.setCustomValidity('');
    authForm.elements.email.focus();
  });

  recoveryForm.addEventListener('submit', (event) => {
    if (recoveryForm.dataset.handlerReady === 'true') return;
    event.preventDefault();
    if (!recoveryEmail.value.trim() || !recoveryEmail.validity.valid ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recoveryEmail.value.trim())) {
      setRecoveryMessage('Enter a valid email address.', true);
      recoveryEmail.focus();
      return;
    }
    if (waitingForHandler) return;
    waitingForHandler = true;
    sendResetButton.disabled = true;
    sendResetButton.textContent = 'Connecting…';
    setRecoveryMessage('Connecting to the existing Community authentication client…', false);

    const resumeSubmission = () => {
      if (!waitingForHandler || recoveryForm.dataset.handlerReady !== 'true') return;
      waitingForHandler = false;
      window.clearTimeout(handlerTimeout);
      document.removeEventListener('community:password-recovery-ready', resumeSubmission);
      sendResetButton.disabled = false;
      sendResetButton.textContent = 'Send Reset Link';
      recoveryForm.requestSubmit(sendResetButton);
    };
    document.addEventListener('community:password-recovery-ready', resumeSubmission);
    handlerTimeout = window.setTimeout(() => {
      if (!waitingForHandler) return;
      waitingForHandler = false;
      document.removeEventListener('community:password-recovery-ready', resumeSubmission);
      sendResetButton.disabled = false;
      sendResetButton.textContent = 'Send Reset Link';
      console.error('The Community auth module did not register the password recovery handler.');
      setRecoveryMessage('Community authentication did not initialize. Check the browser console and make sure js/community.js loads over HTTP or HTTPS.', true);
    }, 15000);
  });
})();
