(function () {
  'use strict';
  var form = document.querySelector('#contact-form');
  if (!form) return;

  var status = form.querySelector('[role="status"]');
  var submitButton = form.querySelector('button[type="submit"]');
  if (window.__CONTACT_ENDPOINT__) submitButton.textContent = 'Send message';
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    status.className = 'form-status';
    status.textContent = '';
    if (!form.reportValidity()) return;

    var name = form.elements.name.value.trim();
    var email = form.elements.email.value.trim();
    var subject = form.elements.subject.value.trim();
    var message = form.elements.message.value.trim();
    if (form.elements.website.value) {
      status.textContent = 'Your message could not be accepted.';
      status.className = 'form-status error';
      return;
    }
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !subject || !message) {
      status.className = 'form-status error';
      status.textContent = 'Please enter a name, valid email, subject, and message.';
      return;
    }

    var endpoint = window.__CONTACT_ENDPOINT__;
    if (endpoint) {
      submitButton.disabled = true;
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, subject: subject, message: message, website: '' })
      }).then(function (response) {
        return response.json().then(function (result) {
          if (!response.ok || result.ok !== true) throw new Error(result.error || 'The message could not be delivered.');
          status.className = 'form-status success';
          status.textContent = 'Message accepted by the email service.';
          form.reset();
        });
      }).catch(function (error) {
        status.className = 'form-status error';
        status.textContent = error.message || 'The message could not be delivered. Please email me directly.';
      }).finally(function () { submitButton.disabled = false; });
      return;
    }

    var body = 'Name: ' + name + '\nEmail: ' + email + '\n\n' + message;
    window.location.href = 'mailto:mayanksaini1072007@gmail.com?subject=' +
      encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    status.textContent = 'Your email app should open with this message. This website has not sent it; please send it from your email app.';
  });
})();
