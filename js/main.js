(function () {
  'use strict';
  var themeModes = ['dark', 'light', 'system'];
  var themeLabels = { dark: 'Dark Mode', light: 'Light Mode', system: 'System Mode' };
  var themeIcons = {
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.2 15.4A8.8 8.8 0 0 1 8.6 3.8 8.9 8.9 0 1 0 20.2 15.4Z"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>',
    system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>'
  };
  var themeMedia = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var themePreference = 'dark';
  var themeTrigger = null;
  var themeTriggerIcon = null;
  var themeTriggerLabel = null;
  var themeOptions = [];
  var themeNav = document.querySelector('.nav-links');
  var navToggle = document.querySelector('.nav-toggle');

  try {
    var savedTheme = window.localStorage.getItem('mayank-portfolio-theme');
    if (themeModes.indexOf(savedTheme) !== -1) themePreference = savedTheme;
  } catch (error) {
    console.warn('Theme preference could not be read from local storage.', error);
  }

  function updateTheme() {
    var effectiveTheme = themePreference === 'system'
      ? (themeMedia && themeMedia.matches ? 'dark' : 'light')
      : themePreference;
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    document.documentElement.setAttribute('data-theme-preference', themePreference);

    var themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute('content', effectiveTheme === 'light' ? '#f4f7fb' : '#07111f');

    if (themeTrigger) {
      themeTrigger.setAttribute('aria-label', 'Theme: ' + themeLabels[themePreference]);
      themeTrigger.title = 'Theme: ' + themeLabels[themePreference];
      themeTriggerIcon.innerHTML = themeIcons[themePreference];
      themeTriggerLabel.textContent = 'Theme';
    }
    themeOptions.forEach(function (option) {
      option.setAttribute('aria-checked', String(option.getAttribute('data-theme-choice') === themePreference));
    });
  }

  updateTheme();

  if (themeMedia) {
    var onSystemThemeChange = function () {
      if (themePreference === 'system') updateTheme();
    };
    if (typeof themeMedia.addEventListener === 'function') {
      themeMedia.addEventListener('change', onSystemThemeChange);
    } else if (typeof themeMedia.addListener === 'function') {
      themeMedia.addListener(onSystemThemeChange);
    }
  }

  if (themeNav && !themeNav.querySelector('.theme-switcher')) {
    var switcher = document.createElement('div');
    switcher.className = 'theme-switcher';
    var trigger = document.createElement('button');
    trigger.className = 'theme-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'theme-menu');
    themeTrigger = trigger;

    themeTriggerIcon = document.createElement('span');
    themeTriggerIcon.className = 'theme-icon';
    themeTriggerIcon.setAttribute('aria-hidden', 'true');
    themeTriggerLabel = document.createElement('span');
    themeTriggerLabel.className = 'theme-trigger-label';
    trigger.appendChild(themeTriggerIcon);
    trigger.appendChild(themeTriggerLabel);

    var menu = document.createElement('div');
    menu.className = 'theme-menu';
    menu.id = 'theme-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Theme options');
    menu.hidden = true;

    themeModes.forEach(function (mode) {
      var option = document.createElement('button');
      option.className = 'theme-option';
      option.type = 'button';
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('data-theme-choice', mode);
      option.setAttribute('aria-checked', 'false');
      option.tabIndex = -1;

      var icon = document.createElement('span');
      icon.className = 'theme-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = themeIcons[mode];
      var label = document.createElement('span');
      label.textContent = themeLabels[mode];
      var check = document.createElement('span');
      check.className = 'theme-check';
      check.setAttribute('aria-hidden', 'true');
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>';
      option.appendChild(icon);
      option.appendChild(label);
      option.appendChild(check);
      menu.appendChild(option);
      themeOptions.push(option);
    });

    function setThemeMenuOpen(isOpen) {
      menu.hidden = !isOpen;
      trigger.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) {
        var activeOption = themeOptions.find(function (option) {
          return option.getAttribute('data-theme-choice') === themePreference;
        });
        if (activeOption) activeOption.focus();
      }
    }

    trigger.addEventListener('click', function () {
      setThemeMenuOpen(trigger.getAttribute('aria-expanded') !== 'true');
    });
    themeOptions.forEach(function (option) {
      option.addEventListener('click', function () {
        var selectedTheme = option.getAttribute('data-theme-choice');
        if (themeModes.indexOf(selectedTheme) === -1) return;
        themePreference = selectedTheme;
        try {
          window.localStorage.setItem('mayank-portfolio-theme', themePreference);
        } catch (error) {
          console.error('Theme preference could not be saved to local storage.', error);
        }
        updateTheme();
        setThemeMenuOpen(false);
        if (themeNav.classList.contains('open')) {
          themeNav.classList.remove('open');
          if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
        }
        trigger.focus();
      });
    });
    menu.addEventListener('keydown', function (event) {
      var currentIndex = themeOptions.indexOf(document.activeElement);
      var nextIndex = currentIndex;
      if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % themeOptions.length;
      else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + themeOptions.length) % themeOptions.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = themeOptions.length - 1;
      else if (event.key === 'Escape') {
        setThemeMenuOpen(false);
        trigger.focus();
        return;
      } else {
        return;
      }
      event.preventDefault();
      themeOptions[nextIndex].focus();
    });
    document.addEventListener('click', function (event) {
      if (!switcher.contains(event.target)) setThemeMenuOpen(false);
    });
    switcher.addEventListener('focusout', function () {
      window.setTimeout(function () {
        if (!switcher.contains(document.activeElement)) setThemeMenuOpen(false);
      }, 0);
    });

    switcher.appendChild(trigger);
    switcher.appendChild(menu);
    themeNav.appendChild(switcher);
    updateTheme();
  }

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.nav-links');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(isOpen));
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  var year = document.querySelector('[data-current-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  var topButton = document.querySelector('.to-top');
  function updateTopButton() {
    if (topButton) topButton.classList.toggle('show', window.scrollY > 420);
  }
  window.addEventListener('scroll', updateTopButton, { passive: true });
  updateTopButton();
  if (topButton) topButton.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (item) { observer.observe(item); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (item) { item.classList.add('visible'); });
  }

  var roles = document.querySelector('[data-roles]');
  if (roles && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var values = roles.getAttribute('data-roles').split('|');
    var index = 0;
    var char = 0;
    var deleting = false;
    var output = roles.querySelector('[data-role-text]');
    var type = function () {
      var value = values[index];
      char += deleting ? -1 : 1;
      output.textContent = value.slice(0, char);
      var delay = deleting ? 38 : 75;
      if (!deleting && char === value.length) {
        deleting = true;
        delay = 1350;
      } else if (deleting && char === 0) {
        deleting = false;
        index = (index + 1) % values.length;
        delay = 350;
      }
      window.setTimeout(type, delay);
    };
    type();
  }

  var lightbox = document.querySelector('.lightbox');
  if (lightbox) {
    var image = lightbox.querySelector('img');
    var caption = lightbox.querySelector('.lightbox-caption');
    var close = function () {
      lightbox.classList.remove('open');
      document.body.style.overflow = '';
    };
    document.querySelectorAll('[data-lightbox]').forEach(function (item) {
      item.addEventListener('click', function () {
        var source = item.querySelector('img');
        image.src = source.currentSrc || source.src;
        image.alt = source.alt;
        caption.textContent = item.getAttribute('data-caption') || source.alt;
        lightbox.classList.add('open');
        document.body.style.overflow = 'hidden';
        lightbox.querySelector('button').focus();
      });
    });
    lightbox.addEventListener('click', function (event) {
      if (event.target === lightbox || event.target.closest('.lightbox-close')) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && lightbox.classList.contains('open')) close();
    });
  }
})();
