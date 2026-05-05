/* Netkem AS – site script (i18n + animations) */
(function () {
  'use strict';

  var doc = document.documentElement;

  /* ---------- Mobile nav toggle ---------- */
  var toggle = document.querySelector('.site-nav__toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      doc.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', doc.classList.contains('is-open'));
    });
  }
  document.querySelectorAll('.mobile-nav a').forEach(function (a) {
    a.addEventListener('click', function () { doc.classList.remove('is-open'); });
  });

  /* ---------- Active page highlight ---------- */
  var path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-nav-link]').forEach(function (link) {
    var target = link.getAttribute('data-nav-link');
    if (target === path || (target === 'index.html' && path === '')) {
      link.classList.add('is-active');
    }
  });

  /* ---------- Year stamp in footer ---------- */
  var year = document.querySelector('[data-year]');
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- Header: toggle .is-scrolled on scroll ---------- */
  var header = document.querySelector('.site-header');
  if (header) {
    var SCROLL_THRESHOLD = 30;
    var setScrolled = function () {
      if (window.scrollY > SCROLL_THRESHOLD) {
        header.classList.add('is-scrolled');
      } else {
        header.classList.remove('is-scrolled');
      }
    };
    setScrolled();
    window.addEventListener('scroll', setScrolled, { passive: true });
  }

  /* i18n is now baked into static HTML via build script.
     Language is selected by URL path: /, /en/, /es/.
     No localStorage, no cookies, no client-side translation. */

  /* ===========================================================
     Animations — reveal on scroll + count-up
     =========================================================== */
  var prefersReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!prefersReduce && 'IntersectionObserver' in window) {
    var revealObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          revealObs.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

    document.querySelectorAll('.reveal').forEach(function (el) { revealObs.observe(el); });

    /* count-up */
    var countObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        countObs.unobserve(el);
        var target = parseInt(el.getAttribute('data-count') || el.textContent, 10);
        if (isNaN(target)) return;
        var suffix = el.getAttribute('data-count-suffix') || '';
        var duration = 1100;
        var start = performance.now();
        function step(now) {
          var p = Math.min(1, (now - start) / duration);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(target * eased) + suffix;
          if (p < 1) requestAnimationFrame(step);
          else el.textContent = target + suffix;
        }
        requestAnimationFrame(step);
      });
    }, { threshold: 0.4 });

    document.querySelectorAll('.count-up').forEach(function (el) { countObs.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* ===========================================================
     Contact form — POST to /api/contact (Resend serverless)
     =========================================================== */
  var contactForm = document.querySelector('form.form[action="/api/contact"]');
  if (contactForm) {
    /* Detect language from URL: /en/ or /es/ → en/es, otherwise nb */
    var lang = (function () {
      var seg = window.location.pathname.split('/').filter(Boolean)[0];
      return (seg === 'en' || seg === 'es') ? seg : 'nb';
    })();

    var STATUS = {
      nb: {
        sending: 'Sender …',
        success: 'Takk! Vi tar kontakt så snart som mulig.',
        missing: 'Fyll inn navn, telefon og e-post.',
        invalid: 'E-postadressen ser ikke gyldig ut.',
        toolong: 'Meldingen er for lang.',
        failed:  'Noe gikk galt. Send oss heller en e-post på post@netkem.no.',
      },
      en: {
        sending: 'Sending …',
        success: 'Thank you! We’ll get back to you as soon as possible.',
        missing: 'Please fill in name, phone and email.',
        invalid: 'That email address doesn’t look valid.',
        toolong: 'Your message is too long.',
        failed:  'Something went wrong. Please email post@netkem.no instead.',
      },
      es: {
        sending: 'Enviando …',
        success: '¡Gracias! Le contactaremos lo antes posible.',
        missing: 'Complete nombre, teléfono y correo.',
        invalid: 'La dirección de correo no parece válida.',
        toolong: 'El mensaje es demasiado largo.',
        failed:  'Algo salió mal. Escríbanos a post@netkem.no.',
      },
    }[lang];

    var statusEl = contactForm.querySelector('.form__status');
    var setStatus = function (state, text) {
      if (!statusEl) return;
      if (state) statusEl.setAttribute('data-state', state); else statusEl.removeAttribute('data-state');
      statusEl.textContent = text || '';
    };

    contactForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (contactForm.classList.contains('is-sending')) return;

      var data = {};
      var fd = new FormData(contactForm);
      fd.forEach(function (v, k) { data[k] = typeof v === 'string' ? v.trim() : v; });
      data._lang = lang;

      contactForm.classList.add('is-sending');
      setStatus('sending', STATUS.sending);

      fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data),
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, body: j }; });
      }).then(function (res) {
        contactForm.classList.remove('is-sending');
        if (res.ok && res.body && res.body.ok) {
          setStatus('success', STATUS.success);
          contactForm.reset();
          return;
        }
        var err = res.body && res.body.error;
        var msg = err === 'missing_fields' ? STATUS.missing
                : err === 'invalid_email'  ? STATUS.invalid
                : err === 'too_long'       ? STATUS.toolong
                : STATUS.failed;
        setStatus('error', msg);
      }).catch(function () {
        contactForm.classList.remove('is-sending');
        setStatus('error', STATUS.failed);
      });
    });
  }
})();
