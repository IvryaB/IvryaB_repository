/*
 * Погода для KaiOS: экраны, навигация с клавиатуры, кэш.
 * Код в ES5 — чтобы работать и на KaiOS 2.5 (Gecko 48), и на KaiOS 3.x.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var I18N = window.I18N;
  var Icons = window.WxIcons;
  var Api = window.WxApi;
  var MAX_CITIES = CFG.MAX_CITIES || 10;

  var $ = function (id) { return document.getElementById(id); };
  var $content = $('content'), $title = $('titlebar'), $toast = $('toast');
  var $skL = $('sk-left'), $skC = $('sk-center'), $skR = $('sk-right');

  /* ================= Хранилище ================= */

  var PREFIX = 'wx.';
  var CACHE_PREFIX = PREFIX + 'c.';

  function load(k, def) {
    try {
      var v = localStorage.getItem(PREFIX + k);
      return v ? JSON.parse(v) : def;
    } catch (e) { return def; }
  }
  function save(k, v) {
    var s = JSON.stringify(v);
    try { localStorage.setItem(PREFIX + k, s); } catch (e) {
      pruneCache(true);
      try { localStorage.setItem(PREFIX + k, s); } catch (e2) { /* нет места */ }
    }
  }
  function extend(a, b) { for (var k in b) { if (b.hasOwnProperty(k)) a[k] = b[k]; } return a; }

  var settings = extend({ units: 'metric', lang: 'auto', geo: true, ttl: 60, apiKey: '' }, load('settings', {}));
  var cities = load('cities', []);
  var geoLoc = load('geo', null);

  var state = {
    idx: load('idx', 0) | 0,
    data: {}, loading: {}, errors: {},
    geoStatus: 'idle',
    hour: 0,
    day: 0,
    view: null,
    prevView: null
  };

  function saveSettings() { save('settings', settings); }

  /* ================= Локализация ================= */

  function lang() {
    if (settings.lang !== 'auto' && I18N[settings.lang]) return settings.lang;
    var n = (navigator.language || 'en').toLowerCase().slice(0, 2);
    if (I18N[n]) return n;
    if (n === 'be' || n === 'kk' || n === 'ky' || n === 'uz' || n === 'tg') return 'ru';
    return 'en';
  }
  function t(k, arg) {
    var L = I18N[lang()];
    var s = (L && L[k] !== undefined) ? L[k] : (I18N.en[k] !== undefined ? I18N.en[k] : k);
    if (arg !== undefined && typeof s === 'string') s = s.replace('%s', arg);
    return s;
  }
  function apiLang() { return { ru: 'ru-ru', uk: 'uk-ua', en: 'en-us' }[lang()] || 'en-us'; }
  function apiKey() { return (settings.apiKey || CFG.ACCUWEATHER_API_KEY || '').replace(/\s+/g, ''); }

  Api.init({ getKey: apiKey });

  /* ================= Форматирование ================= */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fTemp(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    var r = Math.round(v);
    return (r < 0 ? '−' + (-r) : String(r)) + '°';
  }
  function ruLike() { var l = lang(); return l === 'ru' || l === 'uk'; }
  function fWind(v, metric) {
    if (v === null || v === undefined) return '--';
    if (!metric) return Math.round(v) + ' ' + t('u_mph');
    if (ruLike()) return Math.round(v / 3.6) + ' ' + t('u_ms');
    return Math.round(v) + ' ' + t('u_kmh');
  }
  function fPres(v, metric) {
    if (v === null || v === undefined) return '--';
    if (!metric) return v.toFixed(2) + ' ' + t('u_inhg');
    if (ruLike()) return Math.round(v * 0.750062) + ' ' + t('u_mmhg');
    return Math.round(v) + ' ' + t('u_hpa');
  }
  function fVis(v, metric) {
    if (v === null || v === undefined) return '--';
    return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + t(metric ? 'u_km' : 'u_mi');
  }
  function fPct(v) { return (v === null || v === undefined) ? '--' : Math.round(v) + '%'; }

  // Время берём прямо из строки ISO, т.е. в часовом поясе города, а не телефона
  function hm(iso) {
    if (!iso || iso.length < 16) return null;
    return { h: parseInt(iso.substr(11, 2), 10), m: parseInt(iso.substr(14, 2), 10) };
  }
  function fClock(iso) {
    var x = hm(iso);
    if (!x) return '--';
    if (lang() === 'en') {
      var h12 = x.h % 12 || 12;
      return h12 + ':' + pad(x.m) + (x.h < 12 ? ' AM' : ' PM');
    }
    return pad(x.h) + ':' + pad(x.m);
  }
  function fHour(iso) {
    var x = hm(iso);
    if (!x) return '--';
    if (lang() === 'en') return (x.h % 12 || 12) + (x.h < 12 ? ' AM' : ' PM');
    return pad(x.h) + ':00';
  }
  function dateParts(iso) {
    var y = parseInt(iso.substr(0, 4), 10), mo = parseInt(iso.substr(5, 2), 10), d = parseInt(iso.substr(8, 2), 10);
    return { y: y, m: mo - 1, d: d, wd: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
  }
  function dayLabel(iso, i) {
    if (i === 0) return t('today');
    return t('days')[dateParts(iso).wd];
  }
  function dayTitle(iso, i) {
    var p = dateParts(iso);
    var name = i === 0 ? t('today') : (i === 1 ? t('tomorrow') : t('daysLong')[p.wd]);
    var date = lang() === 'en' ? t('months')[p.m] + ' ' + p.d : p.d + ' ' + t('months')[p.m];
    return name + ', ' + date;
  }
  function localTime(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  function errText(e) {
    var type = e && e.type;
    return t({ nokey: 'needKey', key: 'errKey', forbidden: 'errForbidden', limit: 'errLimit', net: 'errNet' }[type] || 'errServer');
  }

  /* ================= Локации и кэш ================= */

  function locations() {
    var l = [];
    if (settings.geo) l.push({ geo: true, loc: geoLoc });
    for (var i = 0; i < cities.length; i++) l.push({ geo: false, loc: cities[i] });
    return l;
  }
  function currentEntry() {
    var l = locations();
    if (!l.length) return null;
    if (state.idx >= l.length) state.idx = l.length - 1;
    if (state.idx < 0) state.idx = 0;
    return l[state.idx];
  }
  function setIdx(i) { state.idx = i; save('idx', i); }

  function cacheKey(locKey) { return 'c.' + locKey + '.' + lang() + '.' + settings.units; }

  function weatherFor(loc) {
    if (!loc) return null;
    var ck = cacheKey(loc.key);
    if (!state.data[ck]) {
      var c = load(ck, null);
      if (c) state.data[ck] = c;
    }
    return state.data[ck] || null;
  }

  // Удаляем кэш городов, которых больше нет, и данные в другом языке/единицах
  function pruneCache(aggressive) {
    var keep = {};
    locations().forEach(function (e) { if (e.loc) keep[CACHE_PREFIX + e.loc.key + '.' + lang() + '.' + settings.units] = 1; });
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0 && (aggressive || !keep[k])) localStorage.removeItem(k);
      }
    } catch (e) { /* ignore */ }
    if (aggressive) state.data = {};
  }

  function isCurrentLoc(locKey) {
    var e = currentEntry();
    return !!(e && e.loc && e.loc.key === locKey);
  }

  function loadWeather(loc, force) {
    if (!loc) return;
    var ck = cacheKey(loc.key);
    var w = weatherFor(loc);
    var fresh = w && (Date.now() - w.t < settings.ttl * 60000);
    if ((fresh && !force) || state.loading[ck]) return;
    if (!apiKey()) { state.errors[ck] = new Api.Error('nokey'); return; }

    state.loading[ck] = true;
    state.errors[ck] = null;
    var metric = settings.units === 'metric';
    Api.weather(loc.key, apiLang(), metric).then(function (data) {
      state.loading[ck] = false;
      state.data[ck] = data;
      save(ck, data);
      if (state.view === 'main' && isCurrentLoc(loc.key)) renderMain(true);
    }, function (err) {
      state.loading[ck] = false;
      state.errors[ck] = err;
      if (state.view === 'main' && isCurrentLoc(loc.key)) {
        toast(errText(err));
        renderMain(true);
      }
    });
    if (state.view === 'main') renderStatus();
  }

  function distKm(a, b, c, d) {
    var r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 6371;
  }

  // Определение местоположения. Геокодинг в AccuWeather (1 запрос) делаем
  // только если сдвинулись больше чем на 5 км или сменился язык.
  function resolveGeo(force) {
    if (!settings.geo || !apiKey()) return;
    if (!navigator.geolocation) { state.geoStatus = 'unsupported'; return; }
    if (state.geoStatus === 'locating') return;
    var recent = geoLoc && geoLoc.lang === lang() && Date.now() - geoLoc.ts < 30 * 60000;
    if (recent && !force) { state.geoStatus = 'ok'; return; }

    state.geoStatus = 'locating';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var done = function () {
        state.geoStatus = 'ok';
        if (state.view === 'main' && currentEntry() && currentEntry().geo) {
          loadWeather(geoLoc, false);
          renderMain(true);
        }
      };
      if (geoLoc && geoLoc.lang === lang() && distKm(geoLoc.lat0, geoLoc.lon0, lat, lon) < 5) {
        geoLoc.ts = Date.now();
        save('geo', geoLoc);
        done();
        return;
      }
      Api.geoposition(lat, lon, apiLang()).then(function (loc) {
        loc.lat0 = lat; loc.lon0 = lon; loc.ts = Date.now(); loc.lang = lang();
        geoLoc = loc;
        save('geo', geoLoc);
        done();
      }, function (err) {
        state.geoStatus = geoLoc ? 'ok' : 'error';
        geoFail(errText(err));
      });
    }, function () {
      state.geoStatus = geoLoc ? 'ok' : 'error';
      geoFail(t('locError'));
    }, { enableHighAccuracy: false, timeout: 20000, maximumAge: 30 * 60000 });
  }
  function geoFail(msg) {
    if (state.view === 'main' && currentEntry() && currentEntry().geo) {
      toast(msg);
      renderMain(true);
    }
  }

  /* ================= UI: общие элементы ================= */

  var toastTimer = null;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.className = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.className = 'hidden'; }, 2800);
  }

  function softkeys(l, c, r) {
    $skL.textContent = l || '';
    $skC.textContent = c || '';
    $skR.textContent = r || '';
  }

  function setTitle(text) {
    if (text) { $title.textContent = text; $title.className = ''; } else { $title.className = 'hidden'; }
  }

  function setTheme(name) { document.body.className = 't-' + name; }

  // Список фокусируемых элементов (.f) текущего экрана
  var nav = { items: [], idx: 0 };

  function collect(idx) {
    nav.items = $content.querySelectorAll('.f');
    nav.idx = Math.max(0, Math.min(idx || 0, nav.items.length - 1));
    applyFocus();
  }

  function focused() { return nav.items[nav.idx] || null; }

  function applyFocus() {
    for (var i = 0; i < nav.items.length; i++) {
      if (i === nav.idx) nav.items[i].classList.add('focused');
      else nav.items[i].classList.remove('focused');
    }
    var el = focused();
    var input = el ? (el.tagName === 'INPUT' ? el : el.querySelector('input')) : null;
    var active = document.activeElement;
    if (input) {
      if (active !== input) {
        input.focus();
        // курсор в конец, иначе «Назад» (стереть) ничего не удаляет
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
      }
    } else if (active && active.tagName === 'INPUT') {
      active.blur();
    }
    if (el) ensureVisible(el);
    var v = views[state.view];
    if (v && v.softkeys) v.softkeys();
  }

  function ensureVisible(el) {
    if (nav.idx === 0) { $content.scrollTop = 0; return; }
    var cr = $content.getBoundingClientRect();
    var anchorId = el.getAttribute('data-anchor');
    var anchor = anchorId ? $(anchorId) : null;
    var top = (anchor || el).getBoundingClientRect().top - cr.top + $content.scrollTop;
    var bottom = el.getBoundingClientRect().bottom - cr.top + $content.scrollTop;
    var h = $content.clientHeight, pad = 6;
    if (top < $content.scrollTop + pad || bottom - top > h) $content.scrollTop = Math.max(0, top - pad);
    else if (bottom > $content.scrollTop + h - pad) $content.scrollTop = bottom - h + pad;
  }

  function move(d) {
    var n = nav.idx + d;
    if (n < 0 || n >= nav.items.length) return false;
    nav.idx = n;
    applyFocus();
    return true;
  }

  function go(name, arg) {
    var v = views[name];
    state.prevView = state.view;
    state.view = name;
    $content.scrollTop = 0;
    v.enter(arg);
  }

  /* ================= Экран: главный ================= */

  function heroHtml(entry, w, list) {
    var loc = entry.loc;
    var name = loc ? loc.name : t('myLocation');
    var dots = '';
    if (list.length > 1) {
      for (var i = 0; i < list.length; i++) dots += '<i class="' + (i === state.idx ? 'on' : '') + '"></i>';
    }
    var head = '<div class="loc-row"><span class="loc-name">' + (entry.geo ? Icons.pin(14) : '') + esc(name) + '</span>' +
      (dots ? '<span class="dots">' + dots + '</span>' : '') + '</div>';

    if (!w) {
      return '<div class="hero f" data-role="hero">' + head + '<div class="hero-msg" id="hero-msg">' + esc(heroMessage(entry)) + '</div></div>';
    }
    var c = w.cur, d0 = w.days[0] || {};
    return '<div class="hero f" data-role="hero">' + head +
      '<div class="hero-main"><div class="hero-temp">' + fTemp(c.temp) + '</div>' + Icons.svg(c.icon, 72, 'hero-icon') + '</div>' +
      '<div class="hero-text">' + esc(c.text) + '</div>' +
      '<div class="hero-sub">' + fTemp(d0.max) + ' / ' + fTemp(d0.min) + ' · ' + esc(t('feelsLike', fTemp(c.feels))) + '</div>' +
      '<div class="hero-status" id="hero-msg">' + esc(statusLine(entry, w)) + '</div>' +
      '</div>';
  }

  function heroMessage(entry) {
    if (!apiKey()) return t('needKey');
    if (entry.geo && !entry.loc) {
      if (state.geoStatus === 'unsupported') return t('noGeo');
      if (state.geoStatus === 'error') return t('locError') + '. ' + t('locHint');
      return t('locating');
    }
    var err = entry.loc && state.errors[cacheKey(entry.loc.key)];
    if (err) return errText(err);
    return t('loading');
  }

  function statusLine(entry, w) {
    var ck = cacheKey(entry.loc.key);
    if (state.loading[ck]) return t('updating');
    if (entry.geo && state.geoStatus === 'locating') return t('locating');
    var s = t('updated') + ' ' + localTime(w.t);
    if (state.errors[ck]) s += ' · ' + t('stale');
    return s;
  }

  // Обновить только строку статуса, без перерисовки всего экрана
  function renderStatus() {
    var e = currentEntry(), el = $('hero-msg');
    if (!e || !el) return;
    var w = weatherFor(e.loc);
    el.textContent = w ? statusLine(e, w) : heroMessage(e);
  }

  function hourlyHtml(w) {
    var items = '<div class="hr"><div class="hr-t">' + esc(t('now')) + '</div>' + Icons.svg(w.cur.icon, 28) +
      '<div class="hr-v">' + fTemp(w.cur.temp) + '</div><div class="hr-p"></div></div>';
    w.hours.forEach(function (h) {
      items += '<div class="hr"><div class="hr-t">' + fHour(h.dt) + '</div>' + Icons.svg(h.icon, 28) +
        '<div class="hr-v">' + fTemp(h.temp) + '</div><div class="hr-p">' + (h.pop >= 20 ? h.pop + '%' : '') + '</div></div>';
    });
    return '<section class="card" id="sec-hours"><h2>' + esc(t('hourly')) + '</h2>' +
      '<div class="hours f" data-role="hours" data-anchor="sec-hours"><div class="hrow" id="hrow">' + items + '</div></div></section>';
  }

  function dailyHtml(w) {
    if (!w.days.length) return '';
    var lo = Infinity, hi = -Infinity;
    w.days.forEach(function (d) { if (d.min < lo) lo = d.min; if (d.max > hi) hi = d.max; });
    var range = Math.max(1, hi - lo);
    var rows = '';
    w.days.forEach(function (d, i) {
      var left = (d.min - lo) / range * 100, width = Math.max(6, (d.max - d.min) / range * 100);
      if (left + width > 100) left = 100 - width;
      var dot = '';
      if (i === 0 && w.cur.temp !== null) {
        var pos = Math.max(0, Math.min(100, (w.cur.temp - lo) / range * 100));
        dot = '<i class="bar-dot" style="left:' + pos.toFixed(1) + '%"></i>';
      }
      var pop = Math.max(d.d.pop || 0, d.n.pop || 0);
      rows += '<div class="drow f" data-role="day" data-i="' + i + '"' + (i === 0 ? ' data-anchor="sec-days"' : '') + '>' +
        '<span class="d-name">' + esc(dayLabel(d.date, i)) + '</span>' +
        Icons.svg(d.d.icon, 26) +
        '<span class="d-pop">' + (pop >= 20 ? pop + '%' : '') + '</span>' +
        '<span class="d-min">' + fTemp(d.min) + '</span>' +
        '<span class="bar"><i style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></i>' + dot + '</span>' +
        '<span class="d-max">' + fTemp(d.max) + '</span></div>';
    });
    return '<section class="card" id="sec-days"><h2>' + esc(t('daily')) + '</h2>' + rows + '</section>';
  }

  function tile(label, value) {
    return '<div class="tile"><div class="tl">' + esc(label) + '</div><div class="tv">' + esc(value) + '</div></div>';
  }

  function detailsHtml(w) {
    var c = w.cur, d0 = w.days[0] || {}, m = w.m;
    var uv = c.uv === null ? '--' : c.uv + (c.uvText ? ' · ' + c.uvText : '');
    var tiles = [
      [t('feels'), fTemp(c.feels)], [t('humidity'), fPct(c.hum)],
      [t('wind'), fWind(c.wind, m) + (c.dir ? ' ' + c.dir : '')], [t('uv'), uv],
      [t('pressure'), fPres(c.pres, m)], [t('visibility'), fVis(c.vis, m)],
      [t('sunrise'), fClock(d0.rise)], [t('sunset'), fClock(d0.set)],
      [t('dew'), fTemp(c.dew)], [t('clouds'), fPct(c.cloud)]
    ];
    var rows = '';
    for (var i = 0; i < tiles.length; i += 2) {
      rows += '<div class="trow f"' + (i === 0 ? ' data-anchor="sec-det"' : '') + '>' +
        tile(tiles[i][0], tiles[i][1]) + (tiles[i + 1] ? tile(tiles[i + 1][0], tiles[i + 1][1]) : '') + '</div>';
    }
    return '<section class="card plain" id="sec-det"><h2>' + esc(t('details')) + '</h2>' + rows + '</section>';
  }

  function renderMain(keep) {
    var list = locations();
    var prevIdx = keep ? nav.idx : 0, prevScroll = keep ? $content.scrollTop : 0;
    setTitle('');

    if (!list.length) {
      setTheme('clear-day');
      $content.innerHTML = '<div class="empty f" data-role="add">' + Icons.svg(3, 72) +
        '<div class="empty-t">' + esc(t('noCities')) + '</div><div class="empty-s">' + esc(t('noCitiesHint')) + '</div>' +
        '<div class="btn">' + esc(t('addCity')) + '</div></div>';
      collect(0);
      return;
    }

    var entry = currentEntry();
    var w = weatherFor(entry.loc);
    setTheme(w ? Icons.theme(w.cur.icon, w.cur.day) : (entry.loc ? 'cloudy-day' : 'clear-day'));

    var html = heroHtml(entry, w, list);
    if (w) {
      if (w.headline) html += '<div class="headline">' + esc(w.headline) + '</div>';
      html += hourlyHtml(w) + dailyHtml(w) + detailsHtml(w) +
        '<div class="foot f">' + esc(t('dataBy')) + ' · ' + esc(t('updated')) + ' ' + localTime(w.t) + '</div>';
    }
    $content.innerHTML = html;
    if (state.hour > (w ? w.hours.length : 0)) state.hour = 0;
    collect(prevIdx);
    if (keep && prevIdx > 0) $content.scrollTop = prevScroll;
    updateHours();
  }

  function updateHours() {
    var row = $('hrow');
    if (!row) return;
    var el = focused();
    var active = !!(el && el.getAttribute('data-role') === 'hours');
    var cells = row.children;
    for (var i = 0; i < cells.length; i++) {
      if (active && i === state.hour) cells[i].classList.add('sel'); else cells[i].classList.remove('sel');
    }
    var cell = cells[state.hour];
    if (!cell) return;
    var box = row.parentNode;
    var left = cell.offsetLeft, right = left + cell.offsetWidth;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
  }

  function switchCity(d) {
    var list = locations();
    if (list.length < 2) return;
    setIdx((state.idx + d + list.length) % list.length);
    state.hour = 0;
    enterLocation(false);
  }

  function enterLocation(force) {
    var entry = currentEntry();
    renderMain(false);
    if (!entry) return;
    if (entry.geo) {
      resolveGeo(force);
      if (geoLoc) loadWeather(geoLoc, force);
      if (state.geoStatus === 'locating' || state.geoStatus === 'unsupported') renderStatus();
    } else {
      loadWeather(entry.loc, force);
    }
    renderStatus();
  }

  var views = {};

  views.main = {
    enter: function () { enterLocation(false); },
    softkeys: function () {
      var el = focused(), role = el && el.getAttribute('data-role');
      var c = role === 'day' ? t('open') : (role === 'add' ? t('add') : t('refresh'));
      softkeys(t('cities'), c, t('settings'));
      updateHours();
    },
    key: function (k, e) {
      var el = focused(), role = el && el.getAttribute('data-role');
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'ArrowLeft':
        case 'ArrowRight':
          var d = k === 'ArrowLeft' ? -1 : 1;
          if (role === 'hours') {
            var n = $('hrow').children.length;
            state.hour = Math.max(0, Math.min(n - 1, state.hour + d));
            updateHours();
          } else {
            switchCity(d);
          }
          break;
        case 'Enter':
          if (role === 'day') go('day', parseInt(el.getAttribute('data-i'), 10));
          else if (role === 'add') go('search');
          else enterLocation(true);
          break;
        case 'SoftLeft': go('cities'); break;
        case 'SoftRight': go('settings'); break;
        case 'Backspace':
          if (nav.idx > 0) { e.preventDefault(); collect(0); }
          // иначе — системное поведение: выход из приложения
          break;
        default: return;
      }
    }
  };

  /* ================= Экран: день ================= */

  views.day = {
    enter: function (i) { state.day = i || 0; this.render(); },
    render: function () {
      var entry = currentEntry(), w = entry && weatherFor(entry.loc);
      if (!w || !w.days[state.day]) { go('main'); return; }
      var d = w.days[state.day], m = w.m;
      setTheme(Icons.theme(d.d.icon, true));
      setTitle(dayTitle(d.date, state.day));
      var half = function (label, h, icon) {
        return '<section class="card f">' +
          '<div class="half-h">' + Icons.svg(icon, 40) + '<div><div class="half-l">' + esc(label) + '</div>' +
          '<div class="half-p">' + esc(h.long) + '</div></div></div>' +
          '<div class="kv"><span>' + esc(t('precip')) + '</span><b>' + fPct(h.pop) + '</b></div>' +
          '<div class="kv"><span>' + esc(t('wind')) + '</span><b>' + esc(fWind(h.wind, m) + (h.dir ? ' ' + h.dir : '')) + '</b></div>' +
          '</section>';
      };
      var html = '<div class="dhead f">' + Icons.svg(d.d.icon, 64) +
        '<div><div class="dh-t">' + fTemp(d.max) + ' / ' + fTemp(d.min) + '</div>' +
        '<div class="dh-s">' + esc(t('feels')) + ' ' + fTemp(d.fmax) + ' / ' + fTemp(d.fmin) + '</div></div></div>' +
        half(t('day'), d.d, d.d.icon) + half(t('night'), d.n, d.n.icon) +
        '<section class="card f">' +
        '<div class="kv"><span>' + esc(t('uv')) + '</span><b>' + (d.uv === null ? '--' : esc(d.uv + (d.uvText ? ' · ' + d.uvText : ''))) + '</b></div>' +
        '<div class="kv"><span>' + esc(t('sunrise')) + '</span><b>' + fClock(d.rise) + '</b></div>' +
        '<div class="kv"><span>' + esc(t('sunset')) + '</span><b>' + fClock(d.set) + '</b></div>' +
        '</section>';
      $content.innerHTML = html;
      $content.scrollTop = 0;
      collect(0);
    },
    softkeys: function () {
      var entry = currentEntry(), w = entry && weatherFor(entry.loc), n = w ? w.days.length : 0;
      softkeys(state.day > 0 ? '◀' : '', '', state.day < n - 1 ? '▶' : '');
    },
    key: function (k, e) {
      var entry = currentEntry(), w = entry && weatherFor(entry.loc), n = w ? w.days.length : 0;
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'ArrowLeft': case 'SoftLeft':
          if (state.day > 0) { state.day--; this.render(); } break;
        case 'ArrowRight': case 'SoftRight':
          if (state.day < n - 1) { state.day++; this.render(); } break;
        case 'Backspace': case 'Enter':
          e.preventDefault(); backToMain(); break;
        default: return;
      }
    }
  };

  function backToMain() {
    state.view = 'main';
    renderMain(false);
    // вернуть фокус на день, из которого пришли
    var rows = $content.querySelectorAll('.f');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-role') === 'day' && parseInt(rows[i].getAttribute('data-i'), 10) === state.day) {
        nav.idx = i; applyFocus(); return;
      }
    }
  }

  /* ================= Экран: города ================= */

  views.cities = {
    enter: function (focusIdx) {
      setTheme('plain');
      setTitle(t('cities'));
      var list = locations(), html = '';
      list.forEach(function (e, i) {
        var loc = e.loc, w = weatherFor(loc);
        var name = e.geo ? t('myLocation') : loc.name;
        var sub = e.geo ? (loc ? loc.name : t('locating')) : [loc.admin, loc.country].filter(Boolean).join(', ');
        html += '<div class="row f" data-i="' + i + '">' +
          '<div class="row-main"><div class="row-t">' + (e.geo ? Icons.pin(14) : '') + esc(name) + '</div>' +
          '<div class="row-s">' + esc(sub) + '</div></div>' +
          (w ? '<div class="row-w">' + Icons.svg(w.cur.icon, 26) + '<span>' + fTemp(w.cur.temp) + '</span></div>' : '') +
          '</div>';
      });
      html += '<div class="row f add" data-role="add"><div class="row-main"><div class="row-t">+ ' + esc(t('addCity')) + '</div></div></div>';
      $content.innerHTML = html;
      collect(focusIdx === undefined ? state.idx : focusIdx);
    },
    softkeys: function () {
      var el = focused(), i = el ? el.getAttribute('data-i') : null;
      var list = locations();
      var canDel = i !== null && list[+i] && !list[+i].geo;
      softkeys(t('add'), t('select'), canDel ? t('remove') : '');
    },
    key: function (k, e) {
      var el = focused();
      var i = el ? el.getAttribute('data-i') : null;
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'Enter':
          if (i === null) { go('search'); break; }
          setIdx(+i); state.hour = 0; go('main'); break;
        case 'SoftLeft': go('search'); break;
        case 'SoftRight':
          var list = locations(), entry = i !== null ? list[+i] : null;
          if (!entry || entry.geo) break;
          if (!window.confirm(t('confirmRemove', entry.loc.name))) break;
          var ci = cities.indexOf(entry.loc);
          cities.splice(ci, 1);
          save('cities', cities);
          if (state.idx > +i) setIdx(state.idx - 1);
          else if (state.idx === +i) setIdx(Math.max(0, Math.min(state.idx, locations().length - 1)));
          pruneCache(false);
          toast(t('removed'));
          this.enter(Math.min(+i, locations().length));
          break;
        case 'Backspace': e.preventDefault(); go('main'); break;
        default: return;
      }
    }
  };

  /* ================= Экран: поиск города ================= */

  var search = { q: '', results: [], status: '', busy: false };

  views.search = {
    enter: function () {
      setTheme('plain');
      setTitle(t('addCity'));
      search.results = []; search.status = t('searchHint'); search.q = '';
      this.render(0);
    },
    render: function (focusIdx) {
      var html = '<div class="inrow f"><input id="q" type="text" autocomplete="off" placeholder="' +
        esc(t('searchPh')) + '" value="' + esc(search.q) + '"></div>';
      if (search.status) html += '<div class="hint">' + esc(search.status) + '</div>';
      search.results.forEach(function (r, i) {
        html += '<div class="row f" data-i="' + i + '"><div class="row-main"><div class="row-t">' + esc(r.name) + '</div>' +
          '<div class="row-s">' + esc([r.admin, r.country].filter(Boolean).join(', ')) + '</div></div></div>';
      });
      $content.innerHTML = html;
      collect(focusIdx || 0);
    },
    softkeys: function () {
      var el = focused();
      var onInput = el && el.classList.contains('inrow');
      softkeys(t('cancel'), onInput ? t('find') : t('add'), '');
    },
    run: function () {
      var input = $('q');
      var q = input ? input.value.replace(/^\s+|\s+$/g, '') : '';
      search.q = input ? input.value : '';
      if (!q || search.busy) return;
      search.busy = true;
      search.status = t('searching');
      search.results = [];
      this.render(0);
      var self = this;
      Api.searchCities(q, apiLang()).then(function (list) {
        search.busy = false;
        search.results = list;
        search.status = list.length ? '' : t('noResults');
        if (state.view === 'search') self.render(list.length ? 1 : 0);
      }, function (err) {
        search.busy = false;
        search.status = errText(err);
        if (state.view === 'search') self.render(0);
      });
    },
    pick: function (r) {
      for (var i = 0; i < cities.length; i++) {
        if (cities[i].key === r.key) {
          toast(t('exists'));
          setIdx(i + (settings.geo ? 1 : 0));
          go('main');
          return;
        }
      }
      if (cities.length >= MAX_CITIES) { toast(t('maxCities', MAX_CITIES)); return; }
      cities.push(r);
      save('cities', cities);
      setIdx(locations().length - 1);
      state.hour = 0;
      toast(t('added'));
      go('main');
    },
    key: function (k, e) {
      var el = focused();
      var onInput = el && el.classList.contains('inrow');
      var input = $('q');
      if (input) search.q = input.value;
      switch (k) {
        case 'ArrowUp': e.preventDefault(); move(-1); break;
        case 'ArrowDown': e.preventDefault(); move(1); break;
        case 'Enter':
          e.preventDefault();
          if (onInput) this.run();
          else if (el) this.pick(search.results[+el.getAttribute('data-i')]);
          break;
        case 'SoftLeft': e.preventDefault(); go('cities', locations().length); break;
        case 'Backspace':
          if (onInput && input && input.value.length) return; // стираем символ
          e.preventDefault();
          go('cities', locations().length);
          break;
        default: return;
      }
    }
  };

  /* ================= Экран: настройки ================= */

  var OPTS = {
    units: ['metric', 'imperial'],
    lang: ['auto', 'ru', 'uk', 'en'],
    geo: [true, false],
    ttl: [30, 60, 120, 180]
  };

  function optLabel(name, v) {
    switch (name) {
      case 'units': return v === 'metric' ? '°C' : '°F';
      case 'lang': return t('langNames')[v];
      case 'geo': return v ? t('on') : t('off');
      case 'ttl': return t('every', v < 60 ? v + ' ' + t('min') : (v / 60) + ' ' + t('hr'));
    }
    return String(v);
  }

  function maskKey(k) {
    if (!k) return CFG.ACCUWEATHER_API_KEY ? '•••• (build)' : t('notSet');
    return '••••' + k.slice(-4);
  }

  views.settings = {
    enter: function (focusIdx) {
      setTheme('plain');
      setTitle(t('settings'));
      var rows = [
        ['units', t('s_units'), optLabel('units', settings.units)],
        ['lang', t('s_lang'), optLabel('lang', settings.lang)],
        ['geo', t('s_geo'), optLabel('geo', settings.geo)],
        ['ttl', t('s_ttl'), optLabel('ttl', settings.ttl)],
        ['key', t('s_key'), maskKey(settings.apiKey)],
        ['about', t('s_about'), '']
      ];
      var html = '';
      rows.forEach(function (r) {
        var cyc = OPTS[r[0]] ? ' cyc' : '';
        html += '<div class="row f' + cyc + '" data-k="' + r[0] + '"><div class="row-main"><div class="row-t">' + esc(r[1]) + '</div>' +
          (r[2] ? '<div class="row-s">' + esc(r[2]) + '</div>' : '') + '</div></div>';
      });
      $content.innerHTML = html;
      collect(focusIdx || 0);
    },
    softkeys: function () {
      var el = focused();
      var k = el && el.getAttribute('data-k');
      softkeys('', k === 'about' ? t('open') : t('change'), '');
    },
    cycle: function (name, d) {
      var list = OPTS[name], cur = settings[name], i = list.indexOf(cur);
      var next = list[(i + d + list.length) % list.length];
      if (name === 'geo' && next !== cur) setIdx(Math.max(0, state.idx + (next ? 1 : -1)));
      settings[name] = next;
      saveSettings();
      if (name === 'units' || name === 'lang') { state.errors = {}; pruneCache(false); }
      if (name === 'geo' && next) state.geoStatus = 'idle';
      this.enter(nav.idx);
    },
    key: function (k, e) {
      var el = focused(), name = el && el.getAttribute('data-k');
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'ArrowLeft': case 'ArrowRight': case 'Enter':
          if (OPTS[name]) this.cycle(name, k === 'ArrowLeft' ? -1 : 1);
          else if (k === 'Enter' && name === 'key') go('apikey');
          else if (k === 'Enter' && name === 'about') go('about');
          break;
        case 'Backspace': e.preventDefault(); go('main'); break;
        default: return;
      }
    }
  };

  views.apikey = {
    enter: function () {
      setTheme('plain');
      setTitle(t('keyTitle'));
      $content.innerHTML = '<div class="inrow f"><input id="key" type="text" autocomplete="off" spellcheck="false" placeholder="' +
        esc(t('keyPh')) + '" value="' + esc(settings.apiKey) + '"></div><div class="hint">' + esc(t('keyHint')) + '</div>';
      collect(0);
    },
    softkeys: function () { softkeys(t('cancel'), t('save'), ''); },
    key: function (k, e) {
      var input = $('key');
      switch (k) {
        case 'Enter':
          e.preventDefault();
          settings.apiKey = input.value.replace(/\s+/g, '');
          saveSettings();
          state.errors = {};
          state.geoStatus = 'idle';
          toast(t('keySaved'));
          go('settings', 4);
          break;
        case 'SoftLeft': e.preventDefault(); go('settings', 4); break;
        case 'Backspace':
          if (input.value.length) return;
          e.preventDefault(); go('settings', 4); break;
        case 'ArrowUp': case 'ArrowDown': e.preventDefault(); break;
        default: return;
      }
    }
  };

  views.about = {
    enter: function () {
      setTheme('plain');
      setTitle(t('helpTitle'));
      var html = '<section class="card f">';
      t('help').forEach(function (h) {
        html += '<div class="kv"><span>' + esc(h[1]) + '</span><b>' + esc(h[0]) + '</b></div>';
      });
      html += '</section><div class="hint f">' + esc(t('aboutData')) + '</div>' +
        '<div class="hint f">' + esc(t('appName')) + ' · ' + esc(t('version', CFG.VERSION || '1.0')) + '</div>';
      $content.innerHTML = html;
      collect(0);
    },
    softkeys: function () { softkeys('', '', ''); },
    key: function (k, e) {
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'Backspace': case 'Enter': e.preventDefault(); go('settings', 5); break;
        default: return;
      }
    }
  };

  /* ================= Клавиатура ================= */

  function normKey(e) {
    var k = e.key;
    // эмуляторы и десктоп: F1/F2 и PageUp/PageDown как софт-клавиши, Escape как «Назад»
    if (k === 'F1' || k === 'PageUp') return 'SoftLeft';
    if (k === 'F2' || k === 'PageDown') return 'SoftRight';
    if (k === 'Escape') return 'Backspace';
    if (k === 'Accept' || k === 'Call') return 'Enter';
    return k;
  }

  document.addEventListener('keydown', function (e) {
    var k = normKey(e);
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (k === 'ArrowUp' || k === 'ArrowDown') e.preventDefault();
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !inInput) e.preventDefault();
    if (k === 'SoftLeft' || k === 'SoftRight') e.preventDefault();
    var v = views[state.view];
    if (v && v.key) v.key(k, e);
  });

  // При возврате в приложение — обновить, если данные устарели
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.view === 'main') {
      var e = currentEntry();
      if (e && e.loc) loadWeather(e.loc, false);
      if (e && e.geo) resolveGeo(false);
    }
  });

  /* ================= Старт ================= */

  document.documentElement.lang = lang();
  document.title = t('appName');
  pruneCache(false);
  go('main');
})();
