(function () {
  'use strict';

  var carousel = document.querySelector('[data-gallery-carousel]');
  if (!carousel) return;

  var viewport = carousel.querySelector('[data-gallery-viewport]');
  var track = carousel.querySelector('[data-gallery-track]');
  var slides = Array.prototype.slice.call(track.querySelectorAll('[data-gallery-slide]'));
  var indicators = carousel.querySelector('[data-gallery-indicators]');
  var counter = carousel.querySelector('[data-gallery-count]');
  var previousButton = carousel.querySelector('[data-gallery-prev]');
  var nextButton = carousel.querySelector('[data-gallery-next]');
  var activeIndex = 0;
  var pointerStartX = null;
  var activePointerId = null;
  var suppressClick = false;

  function updateCarousel() {
    track.style.transform = 'translate3d(' + (-activeIndex * viewport.clientWidth) + 'px, 0, 0)';
    slides.forEach(function (slide, index) {
      var isActive = index === activeIndex;
      var trigger = slide.querySelector('.gallery-photo-trigger');
      slide.setAttribute('aria-hidden', String(!isActive));
      trigger.tabIndex = isActive ? 0 : -1;
      indicators.children[index].setAttribute('aria-current', String(isActive));
    });
    counter.textContent = (activeIndex + 1) + ' / ' + slides.length;
  }

  function showSlide(index) {
    activeIndex = (index + slides.length) % slides.length;
    updateCarousel();
  }

  slides.forEach(function (slide, index) {
    var trigger = slide.querySelector('.gallery-photo-trigger');
    var caption = trigger.getAttribute('data-caption') || trigger.getAttribute('aria-label');
    var dot = document.createElement('button');
    dot.className = 'gallery-dot';
    dot.type = 'button';
    dot.setAttribute('aria-label', 'Show photo ' + (index + 1) + ': ' + caption);
    dot.setAttribute('aria-current', 'false');
    dot.addEventListener('click', function () {
      showSlide(index);
    });
    indicators.appendChild(dot);
  });

  previousButton.addEventListener('click', function () {
    showSlide(activeIndex - 1);
  });
  nextButton.addEventListener('click', function () {
    showSlide(activeIndex + 1);
  });
  carousel.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showSlide(activeIndex - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      showSlide(activeIndex + 1);
    }
  });
  window.addEventListener('resize', updateCarousel);

  viewport.addEventListener('pointerdown', function (event) {
    if (event.pointerType === 'mouse') return;
    pointerStartX = event.clientX;
    activePointerId = event.pointerId;
  });
  window.addEventListener('pointerup', function (event) {
    if (pointerStartX === null || event.pointerId !== activePointerId) return;
    var distance = event.clientX - pointerStartX;
    pointerStartX = null;
    activePointerId = null;
    if (Math.abs(distance) < 45) return;
    suppressClick = true;
    showSlide(activeIndex + (distance < 0 ? 1 : -1));
    window.setTimeout(function () {
      suppressClick = false;
    }, 350);
  });
  window.addEventListener('pointercancel', function () {
    pointerStartX = null;
    activePointerId = null;
  });
  viewport.addEventListener('click', function (event) {
    if (suppressClick && event.target.closest('.gallery-photo-trigger')) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    }
  }, true);

  updateCarousel();
})();
