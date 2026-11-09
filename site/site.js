// Jisste website: theme switch, the scroll-driven "how it works" window, reveals and the hero tilt.
(function () {
  var root = document.documentElement;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // theme: light, dark, or the device's choice until someone picks
  var btn = document.getElementById('themeBtn');
  btn.addEventListener('click', function () {
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('jisste-site-theme', root.dataset.theme); } catch (e) {}
  });

  // the nav gets a hairline once the page moves
  var nav = document.getElementById('nav');

  // each pane's rows come in one after another
  document.querySelectorAll('.pane').forEach(function (pane) {
    var kids = pane.querySelectorAll('.msgs > *, .goal > *, .board .card:not(.c3), .verify > *, .stats > *, .composer');
    kids.forEach(function (el, i) { el.classList.add('in'); el.style.setProperty('--d', (0.12 + i * 0.16).toFixed(2) + 's'); });
  });

  // how it works: the step nearest the middle of the screen drives the window
  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  var panes = document.querySelectorAll('.pane');
  var dots = document.querySelectorAll('#dots i');
  var side = document.querySelectorAll('.ms-i[data-on]');
  var stage = document.getElementById('stage');
  var current = -1;
  function show(n) {
    if (n === current) return;
    current = n;
    stage.dataset.step = n;
    steps.forEach(function (s, i) { s.classList.toggle('on', i === n); });
    panes.forEach(function (p, i) { p.classList.toggle('on', i === n); p.classList.toggle('past', i < n); });
    dots.forEach(function (d, i) { d.classList.toggle('on', i === n); });
    side.forEach(function (s) { s.classList.toggle('on', s.dataset.on.split(' ').indexOf(String(n)) >= 0); });
  }
  function pickStep() {
    var wide = innerWidth >= 900;
    // on phones the window sits at the top, so the reading line is lower down
    var line = wide ? innerHeight * 0.5 : innerHeight * 0.72;
    var best = 0, bestD = Infinity;
    steps.forEach(function (s, i) {
      var r = s.getBoundingClientRect();
      var d = Math.abs(r.top + r.height / 2 - line);
      if (d < bestD) { bestD = d; best = i; }
    });
    show(best);
  }

  // reveals
  var seen = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !still) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); } });
    }, { threshold: 0.18 });
    seen.forEach(function (el) { io.observe(el); });
  } else seen.forEach(function (el) { el.classList.add('seen'); });

  // hero: the window flattens and the phone lifts as you scroll; the giant wordmark rises into place
  var heroWin = document.querySelector('.hero-art');
  var giant = document.querySelector('.giant');
  function frame() {
    nav.classList.toggle('scrolled', scrollY > 8);
    pickStep();
    if (still) return;
    var r = heroWin.getBoundingClientRect();
    var t = Math.min(1, Math.max(0, (r.top - innerHeight * 0.15) / (innerHeight * 0.6)));
    heroWin.style.setProperty('--tilt', t.toFixed(3));
    heroWin.style.setProperty('--lift', (1 - t).toFixed(3));
    var g = giant.getBoundingClientRect();
    var k = Math.min(1, Math.max(0, (innerHeight - g.top) / (g.height * 1.4)));
    giant.style.setProperty('--rise', k.toFixed(3));
  }
  var ticking = false;
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; frame(); }); } }
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);

  // headings that must sit on one line shrink until they fit their column
  function fitOne() {
    document.querySelectorAll('.h2.one').forEach(function (h) {
      h.style.fontSize = '';
      var size = parseFloat(getComputedStyle(h).fontSize), room = h.parentElement.clientWidth;
      if (h.scrollWidth > room) h.style.fontSize = Math.max(15, Math.floor(size * room / h.scrollWidth * 0.98)) + 'px';
    });
  }
  fitOne();
  addEventListener('resize', fitOne);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitOne);
  frame();
})();

// the page's background light follows the scroll a little
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var r = document.documentElement, t = false;
  addEventListener('scroll', function () {
    if (t) return; t = true;
    requestAnimationFrame(function () {
      t = false;
      var k = scrollY / Math.max(1, document.body.scrollHeight - innerHeight);
      r.style.setProperty('--gx', (20 + 60 * Math.sin(k * Math.PI)).toFixed(1) + '%');
      r.style.setProperty('--gy', (25 + 50 * k).toFixed(1) + '%');
    });
  }, { passive: true });
})();

// Open Jisste: choose the app for you, or Jisste Teams for your business
(function () {
  var APP = 'https://app.jisste.noveniqe.com';
  var TEAMS_LIVE = false;   // turn on when teams.jisste.noveniqe.com answers

  // the old app address now shows this website: send installed-app windows and demo links on to the app
  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || /[?&]demo\b/.test(location.search)) { location.replace(APP + location.pathname.replace(/^\/index\.html$/, '/') + location.search + location.hash); return; }
  // (no service worker is registered here: browsers that still have the old app's one fetch sw.js, get the one that
  // removes itself, and reload into this website)

  var box = document.getElementById('choose'), last = null;
  function open(e) { e.preventDefault(); last = document.activeElement; box.hidden = false; box.querySelector('.pick').focus(); }
  function close() { box.hidden = true; if (last) last.focus(); }
  document.querySelectorAll('[data-choose]').forEach(function (a) { a.addEventListener('click', open); });
  if (!TEAMS_LIVE) {
    // until Teams opens, every "start a team" link opens the chooser, where Teams says it is opening soon
    document.querySelectorAll('a[href*="teams.jisste"]').forEach(function (a) {
      if (a.hasAttribute('data-teams')) { a.classList.add('soon'); a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
      else a.addEventListener('click', open);
    });
  }
  box.querySelectorAll('[data-close]').forEach(function (el) { el.addEventListener('click', close); });
  addEventListener('keydown', function (e) { if (e.key === 'Escape' && !box.hidden) close(); });
})();
