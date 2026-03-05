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

  // Registration email auto-fill
  var emailFields = document.querySelectorAll('.contact-email');
  emailFields.forEach(function (field) {
    field.addEventListener('blur', function () {
      var email = field.value.trim();
      if (!email) return;
      var i = field.dataset.player;
      var nameField = document.getElementById('p' + i + '_name');
      var displayField = document.getElementById('p' + i + '_display_name');
      var phoneField = document.getElementById('p' + i + '_phone');

      fetch('/api/lookup-contact?email=' + encodeURIComponent(email))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.found) {
            if (nameField && !nameField.value) nameField.value = data.name;
            if (displayField && !displayField.value && data.display_name) displayField.value = data.display_name;
            if (phoneField && !phoneField.value) phoneField.value = data.phone;
            field.style.borderColor = '#22c55e';
            setTimeout(function () { field.style.borderColor = ''; }, 2000);
          }
        })
        .catch(function () {});
    });
  });

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

  // === Tee Sheet drag-and-drop & controls ===
  var teeList = document.getElementById('tee-order-list');
  if (teeList) {
    recalcTeeTimes();
    var dragItem = null;

    teeList.addEventListener('dragstart', function (e) {
      dragItem = e.target.closest('.tee-order-item');
      if (dragItem) {
        dragItem.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      }
    });

    teeList.addEventListener('dragend', function (e) {
      if (dragItem) dragItem.style.opacity = '1';
      dragItem = null;
      document.querySelectorAll('.tee-order-item').forEach(function (el) {
        el.classList.remove('drag-over');
      });
    });

    teeList.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var target = e.target.closest('.tee-order-item');
      if (target && target !== dragItem) {
        document.querySelectorAll('.tee-order-item').forEach(function (el) {
          el.classList.remove('drag-over');
        });
        target.classList.add('drag-over');
      }
    });

    teeList.addEventListener('drop', function (e) {
      e.preventDefault();
      var target = e.target.closest('.tee-order-item');
      if (target && dragItem && target !== dragItem) {
        var items = Array.from(teeList.children);
        var dragIdx = items.indexOf(dragItem);
        var targetIdx = items.indexOf(target);
        if (dragIdx < targetIdx) {
          teeList.insertBefore(dragItem, target.nextSibling);
        } else {
          teeList.insertBefore(dragItem, target);
        }
        renumberTeeOrder();
      }
    });

    // Listen for start time / interval changes
    var startInput = document.getElementById('tee-start-time');
    var intervalInput = document.getElementById('tee-interval');
    if (startInput) startInput.addEventListener('input', recalcTeeTimes);
    if (intervalInput) intervalInput.addEventListener('input', recalcTeeTimes);
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

// === Tee Sheet helper functions (global scope) ===
function recalcTeeTimes() {
  var startInput = document.getElementById('tee-start-time');
  var intervalInput = document.getElementById('tee-interval');
  if (!startInput || !intervalInput) return;
  var startTime = startInput.value || '8:00 AM';
  var interval = parseInt(intervalInput.value) || 7;

  var match = startTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return;
  var h = parseInt(match[1]);
  var m = parseInt(match[2]);
  var ampm = match[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  var baseMin = h * 60 + m;

  var times = document.querySelectorAll('.tee-order-time');
  times.forEach(function (el, i) {
    var totalMin = baseMin + (i * interval);
    var newH = Math.floor(totalMin / 60) % 24;
    var newM = totalMin % 60;
    var suffix = newH >= 12 ? 'PM' : 'AM';
    var dispH = newH % 12 || 12;
    el.textContent = dispH + ':' + (newM < 10 ? '0' : '') + newM + ' ' + suffix;
  });
}

function renumberTeeOrder() {
  var items = document.querySelectorAll('#tee-order-list .tee-order-item');
  items.forEach(function (el, i) {
    el.querySelector('.tee-order-pos').textContent = (i + 1) + '.';
    var timeEl = el.querySelector('.tee-order-time');
    if (timeEl) timeEl.dataset.index = i;
  });
  recalcTeeTimes();
}

function moveTeeOrder(btn, direction) {
  var item = btn.closest('.tee-order-item');
  var list = item.parentElement;
  var items = Array.from(list.children);
  var idx = items.indexOf(item);
  var newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= items.length) return;
  if (direction === -1) {
    list.insertBefore(item, items[newIdx]);
  } else {
    list.insertBefore(item, items[newIdx].nextSibling);
  }
  renumberTeeOrder();
}

function saveTeeOrder() {
  var items = document.querySelectorAll('#tee-order-list .tee-order-item');
  var order = [];
  items.forEach(function (el, i) {
    order.push({ id: el.dataset.groupId, position: i + 1 });
  });
  fetch('/admin/tee-order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: order })
  }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.ok) {
        var btn = document.querySelector('[onclick="saveTeeOrder()"]');
        if (btn) {
          btn.textContent = 'Saved!';
          btn.style.background = '#22c55e';
          setTimeout(function () { btn.textContent = 'Save Tee Order'; btn.style.background = ''; }, 2000);
        }
      }
    })
    .catch(function (err) { alert('Error saving tee order'); });
}

function scanScorecard(input, groupId) {
  var file = input.files[0];
  if (!file) return;
  var status = document.getElementById('ocr-status-' + groupId);
  if (status) status.textContent = 'Scanning...';

  var formData = new FormData();
  formData.append('scorecard', file);

  fetch('/admin/scores/' + groupId + '/ocr', {
    method: 'POST',
    body: formData
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        if (status) status.textContent = 'Error: ' + data.error;
        return;
      }
      // Fill in hole inputs
      var form = document.getElementById('score-form-' + groupId);
      if (!form) return;
      data.holes.forEach(function (val, i) {
        var inp = form.querySelector('[name="hole_' + (i + 1) + '"]');
        if (inp && val > 0) {
          inp.value = val;
          inp.style.borderColor = '#22c55e';
          inp.style.background = '#f0fdf4';
          setTimeout(function () { inp.style.borderColor = ''; inp.style.background = ''; }, 3000);
        }
      });
      var conf = data.confidence || 'medium';
      var confColors = { high: '#22c55e', medium: '#f59e0b', low: '#ef4444' };
      if (status) {
        status.textContent = 'Scanned (' + conf + ' confidence)';
        status.style.color = confColors[conf] || '';
        if (data.notes) status.textContent += ' — ' + data.notes;
      }
    })
    .catch(function (err) {
      if (status) status.textContent = 'Scan failed. Try again.';
    });

  input.value = '';
}

function saveTeeSettings() {
  var form = document.createElement('form');
  form.method = 'POST';
  form.action = '/admin/tee-settings';
  var startInput = document.getElementById('tee-start-time');
  var intervalInput = document.getElementById('tee-interval');

  var s = document.createElement('input');
  s.type = 'hidden'; s.name = 'tee_start_time'; s.value = startInput.value;
  form.appendChild(s);

  var iv = document.createElement('input');
  iv.type = 'hidden'; iv.name = 'tee_interval'; iv.value = intervalInput.value;
  form.appendChild(iv);

  document.body.appendChild(form);
  form.submit();
}
