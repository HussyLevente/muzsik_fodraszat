/* =====================================================================
   MUZSIK FODRÁSZAT — homepage behaviour
   ---------------------------------------------------------------------
   1.  utils / rAF ticker
   2.  text splitting + reveal observers
   3.  scroll engine  (section cross-fade, parallax, nav theme)
   4.  hero  ·  pinned, and the clip scrubs frame-by-frame with the scroll
   5.  nav + fullscreen menu + back-to-top
   6.  word cycler  (ESKÜVŐ? / RANDI? / VAGY MERT VAN STÍLUSOD.)
   6b. before / after rotation
   7.  booking widget (calendar + time slots)
   ===================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');
  clearTimeout(window.__muzsikFallback);

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- 1 */
  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var lerp  = function (a, b, t) { return a + (b - a) * t; };
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  /* one shared rAF loop --------------------------------------------- */
  var jobs = [];
  var running = false;
  function addJob(fn) { jobs.push(fn); start(); }
  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(loop);
  }
  function loop() {
    for (var i = 0; i < jobs.length; i++) jobs[i]();
    requestAnimationFrame(loop);
  }

  /* viewport cache --------------------------------------------------- */
  var VH = window.innerHeight;
  var VW = window.innerWidth;
  var resizers = [];
  function onResize(fn) { resizers.push(fn); }
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      VH = window.innerHeight;
      VW = window.innerWidth;
      for (var i = 0; i < resizers.length; i++) resizers[i]();
    }, 120);
  }, { passive: true });

  /* ---------------------------------------------------------------- 2 */
  /* split every [data-split] into masked words */
  function splitText(el) {
    if (el.dataset.split === 'done') return;
    var nodes = Array.prototype.slice.call(el.childNodes);
    var frag = document.createDocumentFragment();
    var n = 0;

    function makeWord(content, isNode) {
      var w = document.createElement('span');
      w.className = 'w';
      var inner = document.createElement('i');
      if (isNode) inner.appendChild(content);
      else inner.textContent = content;
      inner.style.setProperty('--d', (n++ * 0.045).toFixed(3) + 's');
      w.appendChild(inner);
      return w;
    }

    nodes.forEach(function (node) {
      if (node.nodeType === 3) {
        node.textContent.split(/(\s+)/).forEach(function (part) {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
          frag.appendChild(makeWord(part, false));
        });
      } else if (node.nodeType === 1) {
        frag.appendChild(makeWord(node.cloneNode(true), true));
      }
    });

    el.textContent = '';
    el.appendChild(frag);
    el.dataset.split = 'done';
  }

  $$('[data-split]').forEach(splitText);

  /* stagger delays */
  $$('[data-stagger]').forEach(function (box) {
    Array.prototype.slice.call(box.children).forEach(function (kid, i) {
      kid.style.setProperty('--d', (i * 0.11).toFixed(2) + 's');
    });
  });

  /* reveal observer */
  if ('IntersectionObserver' in window) {
    /* Reveals replay every time, not just on the first pass. Two observers:
       one arms the animation as the element rises past 88% of the screen,
       the other disarms it only once the element is a comfortable margin
       off-screen — so the rewind is never visible. */
    var armIn = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) e.target.classList.add('is-in');
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0 });

    var armOut = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) e.target.classList.remove('is-in');
      });
    }, { rootMargin: '14% 0px 14% 0px', threshold: 0 });

    $$('[data-split], [data-stagger]').forEach(function (el) {
      armIn.observe(el);
      armOut.observe(el);
    });
  } else {
    $$('[data-split], [data-stagger]').forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ---------------------------------------------------------------- 3 */
  /*  HERO — the pin lasts exactly as long as the clip.
      Scrolling is what advances the footage: the further you are through
      the pinned block, the further the clip has run. Stop scrolling and it
      stops with you, so the hero never outlives its own footage.

      The clip is never played — it is scrubbed, frame by frame. That is
      only affordable because the file now carries a keyframe every fifth
      frame, so a seek in either direction costs a handful of decodes.
      Playing it is what used to break: forward it raced to catch up and
      overshot on a fling, backward it could only jump, which read as a
      stutter.                                                           */

  var heroPin = $('#heroPin');
  var hero    = $('#hero');
  var video   = $('#heroVideo');

  var DUR = 4;                 /* replaced by the real duration    */
  var FPS = 30;                /* the clip's frame rate            */
  var PIN = 0;                 /* pinned scroll distance, in px    */
  var vReady = false;
  var pRaw = 0, pSmooth = 0;

  function sizePin() {
    if (!heroPin) return;
    var pxPerSecond = clamp(VH * 0.6, 300, 680);
    PIN = Math.round(Math.max(DUR * pxPerSecond, VH * 0.85));
    heroPin.style.setProperty('--pin', PIN + 'px');
  }

  /* A seek only lands when the decoder is free. Asking for the next one
     while the last is still in flight is what shreds a fast scroll into
     jerks — so a request made mid-seek is parked here and replayed on the
     way out, and only the newest one ever survives. */
  var seekWant = -1;

  function seekTo(t) {
    try { video.currentTime = t; } catch (e) {}
  }

  function driveVideo(p) {
    if (!video || !vReady || REDUCED) return;

    /* land on a frame boundary — two requests inside the same frame decode
       the same picture twice and buy nothing */
    var t = clamp(Math.round(p * DUR * FPS) / FPS, 0, DUR - 1 / FPS);

    if (Math.abs(t - video.currentTime) < 0.5 / FPS) { seekWant = -1; return; }
    if (video.seeking) { seekWant = t; return; }

    seekWant = -1;
    seekTo(t);
  }

  if (video) {
    var onMeta = function () {
      if (isFinite(video.duration) && video.duration > 0.25) DUR = video.duration;
      sizePin();
      seekTo(1 / FPS);        /* paint a real frame instead of an empty box */
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('loadeddata', function () { vReady = true; });
    video.addEventListener('error',      function () { vReady = false; });

    /* a cached or local file can be ready before this script even runs, and
       then neither event is ever coming — so catch up on what we missed */
    if (video.readyState >= 1) onMeta();
    if (video.readyState >= 2) vReady = true;

    video.addEventListener('seeked', function () {
      if (seekWant < 0) return;
      var t = seekWant;
      seekWant = -1;
      seekTo(t);
    });

    /* a scrubber, never a player — if anything ever starts it, stop it */
    video.addEventListener('play', function () { video.pause(); });
  }
  sizePin();
  onResize(sizePin);

  /* ------------------------------------------- scroll-driven elements */
  var fadeEls   = $$('[data-fade]');
  var paraEls   = $$('[data-parallax]');
  var darkEls   = $$('[data-theme="dark"]');
  var nav       = $('#nav');
  var toTop     = $('#totop');

  var lastY  = -1;
  var extra  = 40;             /* frames to keep ticking after the last move */
  var navLastY = 0;
  var navHidden = false;

  /* every frame: one measurement pass, then one write pass */
  var fadeState = [];
  var paraState = [];

  function tick() {
    var y = window.pageYOffset || root.scrollTop || 0;

    if (y === lastY) {
      /* keep ticking a little past the last movement, so the smoothing —
         and the frame the clip is easing toward — actually arrives */
      if (extra <= 0 && pSmooth === pRaw) return;
      if (extra > 0) extra--;
    } else { extra = 40; }
    lastY = y;

    /* ---------- measure ---------- */
    var heroTop = 0;
    if (heroPin) heroTop = heroPin.getBoundingClientRect().top;

    var i, r;
    fadeState.length = 0;
    for (i = 0; i < fadeEls.length; i++) {
      r = fadeEls[i].getBoundingClientRect();
      fadeState.push(r.top, r.bottom);
    }
    paraState.length = 0;
    for (i = 0; i < paraEls.length; i++) {
      r = paraEls[i].getBoundingClientRect();
      paraState.push(r.top, r.height);
    }
    var band = nav ? nav.offsetHeight * 0.55 : 0;
    var overNav = false;
    for (i = 0; i < darkEls.length; i++) {
      r = darkEls[i].getBoundingClientRect();
      if (r.top <= band && r.bottom >= band) { overNav = true; break; }
    }

    /* ---------- hero ---------- */
    var heroOver = 0;
    if (heroPin) {
      pRaw = clamp(-heroTop / PIN, 0, 1);
      pSmooth = REDUCED ? pRaw : lerp(pSmooth, pRaw, 0.17);
      if (Math.abs(pSmooth - pRaw) < 0.0004) pSmooth = pRaw;
      hero.style.setProperty('--p', pSmooth.toFixed(4));

      heroOver = clamp((-heroTop - PIN) / (VH * 0.8), 0, 1);
      hero.style.opacity = (1 - heroOver).toFixed(3);
      hero.style.visibility = heroOver >= 1 ? 'hidden' : '';

      /* the smoothed value, not the raw one: a fling then becomes a fast
         ramp the decoder can follow instead of a jump it has to chase */
      driveVideo(pSmooth);
    }

    /* ---------- section cross-fade ---------- */
    for (i = 0; i < fadeEls.length; i++) {
      var top = fadeState[i * 2], bot = fadeState[i * 2 + 1];
      if (bot < -VH * 0.6 || top > VH * 1.6) continue;

      var enter = clamp((VH * 0.94 - top) / (VH * 0.5), 0, 1);
      var exit  = clamp((bot - VH * 0.04) / (VH * 0.42), 0, 1);
      var t = easeOut(Math.min(enter, exit));
      var shift = (1 - easeOut(enter)) * 46 - (1 - easeOut(exit)) * 34;

      fadeEls[i].style.opacity = t.toFixed(3);
      fadeEls[i].style.transform = 'translate3d(0,' + shift.toFixed(1) + 'px,0)';
    }

    /* ---------- parallax ---------- */
    if (!REDUCED) {
      for (i = 0; i < paraEls.length; i++) {
        var pt = paraState[i * 2], ph = paraState[i * 2 + 1];
        if (pt + ph < 0 || pt > VH) continue;
        var prog = (VH - pt) / (VH + ph);
        var amt  = parseFloat(paraEls[i].dataset.parallax) || 0;
        paraEls[i].style.transform = 'translate3d(0,' + ((prog - 0.5) * 2 * amt).toFixed(1) + 'px,0)';
      }
    }

    /* ---------- nav: theme, stuck state, hide on the way down ---------- */
    if (nav) {
      var isDark = overNav;
      nav.classList.toggle('is-dark', isDark);
      nav.classList.toggle('is-stuck', y > 30);

      if (!document.body.classList.contains('is-locked')) {
        if (y > navLastY + 4 && y > VH * 0.7 && !navHidden) {
          navHidden = true; nav.classList.add('is-hidden');
        } else if (y < navLastY - 4 && navHidden) {
          navHidden = false; nav.classList.remove('is-hidden');
        }
        if (Math.abs(y - navLastY) > 4) navLastY = y;
      }

      if (toTop) {
        toTop.classList.toggle('is-on', y > (PIN + VH * 0.5));
        toTop.classList.toggle('is-light', isDark);
      }
    }
  }

  addJob(tick);
  /* rAF drives the loop, but a passive scroll listener keeps it honest
     if the browser throttles frames while the user is dragging. */
  window.addEventListener('scroll', tick, { passive: true });
  onResize(function () { lastY = -1; extra = 40; });

  /* ---------------------------------------------------------------- 4 */
  /*  loader                                                             */
  (function () {
    var fill = $('#loaderFill');
    var closed = false;
    var p = 0;
    var id = setInterval(function () {
      p = Math.min(p + Math.random() * 13 + 5, 93);
      if (fill) fill.style.width = p.toFixed(0) + '%';
    }, 130);

    function finish() {
      if (closed) return;
      closed = true;
      clearInterval(id);
      if (fill) fill.style.width = '100%';
      setTimeout(function () {
        document.body.classList.remove('is-loading');
        lastY = -1; extra = 40;
      }, 280);
    }
    if (document.readyState === 'complete') setTimeout(finish, 420);
    else window.addEventListener('load', function () { setTimeout(finish, 240); });
    setTimeout(finish, 3400);
  })();

  /* ---------------------------------------------------------------- 5 */
  /*  fullscreen menu                                                    */
  (function () {
    var burger = $('#burger');
    var menu = $('#menu');
    if (!burger || !menu) return;
    var open = false;
    var closeTimer;

    function setOpen(v) {
      open = v;
      clearTimeout(closeTimer);
      burger.classList.toggle('is-open', v);
      burger.setAttribute('aria-expanded', String(v));
      burger.setAttribute('aria-label', v ? 'Menü bezárása' : 'Menü megnyitása');
      document.body.classList.toggle('is-locked', v);

      if (v) {
        menu.hidden = false;
        void menu.offsetWidth;
        menu.classList.add('is-open');
      } else {
        menu.classList.remove('is-open');
        closeTimer = setTimeout(function () { menu.hidden = true; }, 900);
      }
    }

    burger.addEventListener('click', function () { setOpen(!open); });
    $$('a', menu).forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) setOpen(false);
    });
  })();

  /*  back to top                                                        */
  (function () {
    if (!toTop) return;
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
    });
  })();

  /* ---------------------------------------------------------------- 6 */
  /*  word cycler — ESKÜVŐ? · RANDI? · VAGY MERT VAN STÍLUSOD.           */
  (function () {
    var box = $('#cycler');
    if (!box) return;
    var words = $$('[data-word]', box);
    var dotsBox = $('#cyclerDots');
    if (!words.length) return;

    /* letter masks */
    words.forEach(function (w) {
      var text = w.textContent;
      w.textContent = '';
      var n = 0;
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        if (ch === ' ') { w.appendChild(document.createTextNode('\u00A0')); continue; }
        var mask = document.createElement('span');
        mask.className = 'l';
        mask.style.setProperty('--i', n++);
        var inner = document.createElement('i');
        inner.textContent = ch;
        mask.appendChild(inner);
        w.appendChild(mask);
      }
      w.classList.remove('is-active');
    });

    /* dots */
    var dots = [];
    if (dotsBox) {
      words.forEach(function () {
        var b = document.createElement('b');
        dotsBox.appendChild(b);
        dots.push(b);
      });
    }

    /* each word is scaled to make the most of the space it has */
    function fit() {
      var avail = box.clientWidth;
      if (!avail) return;
      var max = Math.min(VW * 0.075, 145);
      words.forEach(function (w) {
        w.style.fontSize = '100px';
        var natural = w.scrollWidth || 1;
        w.style.fontSize = clamp((avail / natural) * 100, 20, max).toFixed(1) + 'px';
      });
    }
    fit();
    onResize(fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

    var idx = 0, timer = null;
    var HOLD = 4200;

    function paintDots() {
      dots.forEach(function (b, i) {
        b.classList.remove('is-on');
        if (i === idx) { void b.offsetWidth; b.classList.add('is-on'); }
      });
    }

    function show(i) {
      var w = words[i];
      w.classList.remove('is-out');
      w.classList.add('is-live');
      void w.offsetWidth;
      w.classList.add('is-in');
    }

    function hide(i) {
      var w = words[i];
      w.classList.remove('is-in');
      w.classList.add('is-out');
      setTimeout(function () {
        if (w.classList.contains('is-out')) w.classList.remove('is-live', 'is-out');
      }, 950);
    }

    function next() {
      var prev = idx;
      idx = (idx + 1) % words.length;
      hide(prev);
      setTimeout(function () { show(idx); paintDots(); }, 320);
    }

    /* leaving the section rewinds the current word, so coming back to it
       replays the reveal instead of showing a word already in place */
    function play() {
      if (timer) return;
      show(idx);
      paintDots();
      if (words.length > 1 && !REDUCED) timer = setInterval(next, HOLD);
    }
    function pause() {
      clearInterval(timer);
      timer = null;
      words[idx].classList.remove('is-in');
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { e.isIntersecting ? play() : pause(); });
      }, { threshold: 0 }).observe(box);
    } else {
      play();
    }
    document.addEventListener('visibilitychange', function () {
      document.hidden ? pause() : play();
    });
  })();

  /* --------------------------------------------------------------- 6b */
  /*  before / after — three results through the one frame              */
  (function () {
    var ba = $('[data-ba]');
    if (!ba) return;

    var frames = $$('.ba__frame', ba);
    var arrow  = $('.ba__arrow', ba);
    if (frames.length < 2) return;

    var shots = frames.map(function (f) { return $$('img', f); });
    var count = Math.min.apply(null, shots.map(function (s) { return s.length; }));
    if (count < 2) return;

    var HOLD  = 4600;   /* ms a pair stays up            */
    var TRAIL = 220;    /* the "after" side lands late, so the swap still
                           reads left to right, the way the arrow points */
    var idx = 0, timer = null, trail = null;

    function show(n) {
      shots.forEach(function (imgs, col) {
        var swap = function () {
          imgs.forEach(function (img, i) { img.classList.toggle('is-on', i === n); });
        };
        if (col === 0 || REDUCED) swap();
        else trail = setTimeout(swap, TRAIL);
      });

      if (arrow && !REDUCED) {
        arrow.classList.remove('is-pulse');
        void arrow.offsetWidth;          /* restart the animation */
        arrow.classList.add('is-pulse');
      }
    }

    function next() { idx = (idx + 1) % count; show(idx); }

    function play() {
      if (timer || REDUCED) return;
      timer = setInterval(next, HOLD);
    }
    function stop() {
      clearInterval(timer); clearTimeout(trail);
      timer = null; trail = null;
    }

    /* leaving the section winds it back, so coming to it again always
       starts from the first pair rather than mid-rotation */
    function rewind() { stop(); idx = 0; show(0); }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        es.forEach(function (e) { e.isIntersecting ? play() : rewind(); });
      }, { threshold: 0 }).observe(ba);
    } else {
      play();
    }
    document.addEventListener('visibilitychange', function () {
      document.hidden ? stop() : play();
    });
  })();

  /* ---------------------------------------------------------------- 7 */
  /*  booking widget                                                     */
  (function () {
    var form = $('#bookForm');
    if (!form) return;

    var grid     = $('#calGrid');
    var monthEl  = $('#calMonth');
    var prevBtn  = $('#calPrev');
    var nextBtn  = $('#calNext');
    var slotsBox = $('#slots');
    var slotDate = $('#slotDate');
    var doneEl   = $('#bookDone');
    var stylist  = $('#stylist');
    var service  = $('#service');

    var MONTHS = ['Január', 'Február', 'Március', 'Április', 'Május', 'Június',
                  'Július', 'Augusztus', 'Szeptember', 'Október', 'November', 'December'];
    var TIMES = ['14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'];

    var today = new Date(); today.setHours(0, 0, 0, 0);
    var view  = new Date(today.getFullYear(), today.getMonth(), 1);
    var sel = null;
    var selSlot = null;

    /* stable pseudo-random, so a given day always looks the same */
    function hash(n) {
      n = (n ^ 61) ^ (n >>> 16);
      n = n + (n << 3);
      n = n ^ (n >>> 4);
      n = Math.imul(n, 0x27d4eb2d);
      n = n ^ (n >>> 15);
      return n >>> 0;
    }
    function key(y, m, d) { return y * 400 + m * 32 + d; }
    function isSunday(y, m, d) { return new Date(y, m, d).getDay() === 0; }
    function isPast(y, m, d) { return new Date(y, m, d) < today; }
    function isBusy(y, m, d) { return hash(key(y, m, d)) % 100 < 38; }
    function isOpen(y, m, d) { return !isPast(y, m, d) && !isSunday(y, m, d) && !isBusy(y, m, d); }

    function freeTimes(d) {
      if (!d) return [];
      var base = key(d.getFullYear(), d.getMonth(), d.getDate());
      return TIMES.filter(function (t, i) { return hash(base * 13 + i * 7 + 3) % 100 > 26; });
    }

    function firstOpen(from) {
      var probe = new Date(from.getFullYear(), from.getMonth(), from.getDate());
      for (var i = 0; i < 120; i++) {
        if (isOpen(probe.getFullYear(), probe.getMonth(), probe.getDate()) && freeTimes(probe).length) return probe;
        probe.setDate(probe.getDate() + 1);
      }
      return null;
    }

    function cell(tag, cls, txt) {
      var n = document.createElement(tag);
      n.className = cls;
      n.textContent = txt;
      if (tag === 'button') n.type = 'button';
      return n;
    }

    function renderCal() {
      var y = view.getFullYear(), m = view.getMonth();
      monthEl.textContent = MONTHS[m];
      prevBtn.disabled = (y === today.getFullYear() && m === today.getMonth());
      prevBtn.style.opacity = prevBtn.disabled ? '.25' : '';
      prevBtn.style.pointerEvents = prevBtn.disabled ? 'none' : '';

      grid.innerHTML = '';

      var offset = (new Date(y, m, 1).getDay() + 6) % 7;      /* monday first */
      var inMonth = new Date(y, m + 1, 0).getDate();
      var prevLen = new Date(y, m, 0).getDate();
      var total = Math.max(42, Math.ceil((offset + inMonth) / 7) * 7);

      for (var i = 0; i < total; i++) {
        var d = i - offset + 1;

        if (d < 1) { grid.appendChild(cell('span', 'cal__day cal__day--out', prevLen + d)); continue; }
        if (d > inMonth) { grid.appendChild(cell('span', 'cal__day cal__day--out', d - inMonth)); continue; }

        var node;
        if (isPast(y, m, d)) {
          node = cell('span', 'cal__day cal__day--past', d);
        } else if (isSunday(y, m, d)) {
          node = cell('span', 'cal__day', d);
          node.title = 'Vasárnap zárva';
        } else if (isBusy(y, m, d)) {
          node = cell('span', 'cal__day cal__day--busy', d);
          node.title = 'Foglalt';
        } else {
          node = cell('button', 'cal__day cal__day--free', d);
          node.setAttribute('aria-label', MONTHS[m] + ' ' + d + '. — szabad');
          node.dataset.day = d;
        }

        if (sel && sel.getFullYear() === y && sel.getMonth() === m && sel.getDate() === d) {
          node.classList.add('cal__day--sel');
          node.setAttribute('aria-current', 'date');
        }
        grid.appendChild(node);
      }
    }

    function say(msg, ok) {
      doneEl.textContent = msg || '';
      doneEl.classList.toggle('is-on', !!msg);
      doneEl.style.color = (ok === false) ? '#C0392B' : '';
    }

    function renderSlots() {
      slotsBox.innerHTML = '';
      selSlot = null;
      if (!sel) return;

      slotDate.textContent = MONTHS[sel.getMonth()] + ' ' + sel.getDate();
      var list = freeTimes(sel);

      if (!list.length) {
        var p = document.createElement('p');
        p.className = 'slots__empty';
        p.textContent = 'Erre a napra sajnos nincs több szabad időpont.';
        slotsBox.appendChild(p);
        return;
      }

      list.forEach(function (t) {
        var b = cell('button', 'slot', t);
        b.addEventListener('click', function () {
          $$('.slot', slotsBox).forEach(function (s) { s.classList.remove('is-sel'); });
          b.classList.add('is-sel');
          selSlot = t;
          say('');
        });
        slotsBox.appendChild(b);
      });
    }

    function pick(d) {
      sel = new Date(view.getFullYear(), view.getMonth(), d);
      renderCal();
      renderSlots();
      say('');
    }

    grid.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.cal__day--free') : null;
      if (b && b.dataset.day) pick(+b.dataset.day);
    });

    prevBtn.addEventListener('click', function () { view.setMonth(view.getMonth() - 1); renderCal(); });
    nextBtn.addEventListener('click', function () { view.setMonth(view.getMonth() + 1); renderCal(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var missing = [];
      if (!stylist.value) missing.push('szakembert');
      if (!service.value) missing.push('szolgáltatást');
      if (!sel) missing.push('napot');
      if (!selSlot) missing.push('időpontot');

      if (missing.length) {
        say('Válassz még ' + missing.join(', ') + '!', false);
        form.classList.remove('is-shake');
        void form.offsetWidth;
        form.classList.add('is-shake');
        return;
      }
      say('Köszönjük! ' + MONTHS[sel.getMonth()] + ' ' + sel.getDate() + '. ' + selSlot +
          ' — ' + stylist.value + ' · ' + service.value, true);
    });

    [stylist, service].forEach(function (s) {
      s.addEventListener('change', function () { say(''); });
    });

    sel = firstOpen(today);
    if (sel) view = new Date(sel.getFullYear(), sel.getMonth(), 1);
    renderCal();
    renderSlots();
  })();

  /* ------------------------------------------------------------------- */
  /*  anchor jumps have to clear the fixed header                          */
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href');
      if (!id || id.length < 2) return;
      var target = document.getElementById(id.slice(1));
      if (!target) return;
      e.preventDefault();

      if (id === '#top') {
        window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
        return;
      }
      var y = target.getBoundingClientRect().top + (window.pageYOffset || 0) - (nav ? nav.offsetHeight - 2 : 0);
      window.scrollTo({ top: Math.max(0, y), behavior: REDUCED ? 'auto' : 'smooth' });
    });
  });

})();
