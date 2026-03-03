// Mobile nav toggle
document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      links.classList.toggle('open');
    });
  }

  // Mobile dropdown toggle
  var dropdownToggle = document.querySelector('.nav-dropdown-toggle');
  if (dropdownToggle) {
    dropdownToggle.addEventListener('click', function (e) {
      if (window.innerWidth <= 640) {
        e.preventDefault();
        dropdownToggle.parentElement.classList.toggle('open');
      }
    });
  }

  // Hero slideshow
  var slides = document.querySelectorAll('.hero-slide');
  if (slides.length > 1) {
    var current = 0;
    setInterval(function () {
      slides[current].classList.remove('active');
      current = (current + 1) % slides.length;
      slides[current].classList.add('active');
    }, 5000);
  }

  // Gallery lightbox
  var photos = document.querySelectorAll('.photo-card img');
  if (photos.length > 0) {
    var overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    var img = document.createElement('img');
    overlay.appendChild(img);
    document.body.appendChild(overlay);

    photos.forEach(function (photo) {
      photo.addEventListener('click', function () {
        img.src = photo.src;
        overlay.classList.add('active');
      });
    });

    overlay.addEventListener('click', function () {
      overlay.classList.remove('active');
    });
  }
});
