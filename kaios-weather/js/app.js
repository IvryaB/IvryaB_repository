/*
 * Погода для KaiOS: экраны, навигация с клавиатуры, кэш, основной город,
 * автообновление и уведомления по расписанию.
 * Код в ES5 — чтобы работать на KaiOS 2.5 (Gecko 48) и KaiOS 3.x.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var I18N = window.I18N;
  var Icons = window.WxIcons;
  var Api = window.WxApi;
  var Notify = window.WxNotify;
  var MAX_CITIES = CFG.MAX_CITIES || 10;
  var MIN = 60000;

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

  var DEFAULT_NOTIF = {
    on: false, mode: 'interval', every: 3, from: 8, to: 21,
    times: ['08:00', '14:00', '20:00', ''], days: 'daily'
  };

  var settings = extend({ units: 'metric', lang: 'auto', geo: true, ttl: 0, main: '', rkey: 'center0' }, load('settings', {}));
  settings.notif = extend(extend({}, DEFAULT_NOTIF), settings.notif || {});
  // остатки версий 1.0–1.1 (AccuWeather)
  delete settings.apiKey; delete settings.keys; delete settings.provider;

  function migrateLoc(l) {
    if (!l || typeof l.lat !== 'number' || typeof l.lon !== 'number') return null;
    if (!l.id) l.id = l.key ? 'a' + l.key : 'c' + l.lat.toFixed(3) + ',' + l.lon.toFixed(3);
    delete l.key; delete l.ids;
    return l;
  }
  var cities = load('cities', []).map(migrateLoc).filter(Boolean);
  var geoLoc = migrateLoc(load('geo', null));

  var state = {
    idx: load('idx', 0) | 0,
    data: {}, loading: {}, errors: {}, inflight: {},
    geoStatus: 'idle',
    hour: 0, day: 0,
    view: null,
    menu: null,
    digits: ''
  };

  function saveSettings() { save('settings', settings); }
  saveSettings();
  save('cities', cities);

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

  // Что источнику погоды нужно знать о языке и единицах
  function ctx() {
    return {
      lang: lang(),
      metric: settings.units === 'metric',
      wmo: function (c) { var w = t('wmo'); return (w && w[c]) || ''; },
      compass: function (deg) {
        if (deg === null || deg === undefined || isNaN(deg)) return '';
        return t('compass')[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
      },
      uvText: function (v) { return t('uvCat')[v < 3 ? 0 : v < 6 ? 1 : v < 8 ? 2 : v < 11 ? 3 : 4]; }
    };
  }

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
  function fRain(v, metric) {
    if (v === null || v === undefined) return '--';
    return metric ? (Math.round(v * 10) / 10) + ' ' + t('u_mm') : (Math.round(v * 100) / 100) + ' ' + t('u_in');
  }
  function fPct(v) { return (v === null || v === undefined) ? '--' : Math.round(v) + '%'; }

  // Время берём прямо из строки ISO, т.е. в часовом поясе города, а не телефона
  function hm(iso) {
    if (!iso || iso.length < 16) return null;
    return { h: parseInt(iso.substr(11, 2), 10), m: parseInt(iso.substr(14, 2), 10) };
  }
  function clock(h, m) {
    if (lang() === 'en') return (h % 12 || 12) + ':' + pad(m) + (h < 12 ? ' AM' : ' PM');
    return pad(h) + ':' + pad(m);
  }
  function fClock(iso) { var x = hm(iso); return x ? clock(x.h, x.m) : '--'; }
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
  function dayLabel(iso, i) { return i === 0 ? t('today') : t('days')[dateParts(iso).wd]; }
  function dayTitle(iso, i) {
    var p = dateParts(iso);
    var name = i === 0 ? t('today') : (i === 1 ? t('tomorrow') : t('daysLong')[p.wd]);
    var date = lang() === 'en' ? t('months')[p.m] + ' ' + p.d : p.d + ' ' + t('months')[p.m];
    return name + ', ' + date;
  }
  function localTime(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  // Время обновления; если не сегодня — с датой (16.11 20:15)
  function stamp(ms) {
    var d = new Date(ms), n = new Date(Date.now());
    return (d.toDateString() === n.toDateString() ? '' : pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ') + localTime(ms);
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function errText(e) {
    var type = e && e.type;
    return t({ limit: 'errLimit', net: 'errNet' }[type] || 'errServer');
  }

  /* ================= Локации, основной город ================= */

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
  function entryId(e) { return e.geo ? 'geo' : e.loc.id; }

  function mainIndex() {
    if (!settings.main) return -1;
    var l = locations();
    for (var i = 0; i < l.length; i++) if (entryId(l[i]) === settings.main) return i;
    return -1;
  }
  function entryName(e) { return e.geo ? t('myLocation') : e.loc.name; }
  function setMain(id) {
    settings.main = id;
    saveSettings();
  }

  /* ================= Кэш и загрузка погоды ================= */

  function cacheKey(locId) { return 'c.' + locId + '.' + lang() + '.' + settings.units; }

  function weatherFor(loc) {
    if (!loc) return null;
    var ck = cacheKey(loc.id);
    if (!state.data[ck]) {
      var c = load(ck, null);
      if (c && c.cur) state.data[ck] = c;
    }
    return state.data[ck] || null;
  }

  // Удаляем кэш городов, которых больше нет, и данные в другом языке/единицах
  function pruneCache(aggressive) {
    var keep = {};
    locations().forEach(function (e) { if (e.loc) keep[PREFIX + cacheKey(e.loc.id)] = 1; });
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0 && (aggressive || !keep[k])) localStorage.removeItem(k);
      }
    } catch (e) { /* ignore */ }
    if (aggressive) state.data = {};
  }

  function isCurrentLoc(locId) {
    var e = currentEntry();
    return !!(e && e.loc && e.loc.id === locId);
  }

  // «Сейчас» в часовом поясе города: 'ГГГГ-ММ-ДДTЧЧ'
  function cityNow(w) {
    var off = (typeof w.off === 'number') ? w.off : -new Date().getTimezoneOffset() * 60;
    var d = new Date(Date.now() + off * 1000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours());
  }
  // Данные без прошедших дней и часов (если прогноз загружен вчера, «Сегодня» — это действительно сегодня)
  function upToDate(w) {
    if (!w) return w;
    var now = cityNow(w), today = now.slice(0, 10);
    var days = w.days.filter(function (d) { return d.date.slice(0, 10) >= today; }).slice(0, 7);
    var hours = w.hours.filter(function (h) { return h.dt.slice(0, 13) > now; });
    if (days.length === w.days.length && hours.length === w.hours.length) return w;
    return { t: w.t, m: w.m, off: w.off, src: w.src, cur: w.cur, headline: w.headline, days: days, hours: hours };
  }

  // Сколько данные считаются свежими
  function maxAge() {
    if (settings.ttl > 0) return settings.ttl * MIN;
    if (settings.ttl === 0) return 30 * MIN; // «только при открытии»: при смене города — если старше 30 мин
    return Infinity;                          // «только вручную»
  }
  function ageOf(loc) {
    var w = weatherFor(loc);
    if (!w) return Infinity;
    var a = Date.now() - w.t;
    return a < -MIN ? Infinity : a; // часы телефона перевели назад — считаем данные устаревшими
  }

  // Один запрос на место одновременно; результат кладётся в кэш
  function fetchWeather(loc) {
    var ck = cacheKey(loc.id);
    if (state.inflight[ck]) return state.inflight[ck];
    state.loading[ck] = true;
    state.errors[ck] = null;
    var p = Api.get().weather(loc, ctx()).then(function (data) {
      delete state.inflight[ck];
      state.loading[ck] = false;
      data.src = Api.get().id;
      state.data[ck] = data;
      save(ck, data);
      return data;
    }, function (err) {
      delete state.inflight[ck];
      state.loading[ck] = false;
      state.errors[ck] = err;
      throw err;
    });
    state.inflight[ck] = p;
    return p;
  }

  function loadWeather(loc, force) {
    if (!loc) return;
    var ck = cacheKey(loc.id);
    var fresh = ageOf(loc) < maxAge();
    var redraw = function () {
      if (!isCurrentLoc(loc.id)) return;
      if (state.view === 'main') renderMain(true);       // фокус и прокрутка сохраняются
      else if (state.view === 'day') views.day.render(true);
      refreshSoftkeys();
    };
    if (state.inflight[ck]) {
      // загрузка уже идёт (например, от уведомления) — просто дождаться её
      if (force) state.inflight[ck].then(redraw, redraw);
      return;
    }
    if (fresh && !force) return;
    fetchWeather(loc).then(redraw, function (err) {
      if (isCurrentLoc(loc.id) && (state.view === 'main' || state.view === 'day')) toast(errText(err));
      redraw();
      refreshSoftkeys();
    });
    if (state.view === 'main') renderStatus();
    refreshSoftkeys();
  }

  // Идёт ли сейчас обновление текущего места
  function busy() {
    var e = currentEntry();
    return !!(e && ((e.loc && state.loading[cacheKey(e.loc.id)]) || (e.geo && state.geoStatus === 'locating')));
  }
  function refreshSoftkeys() {
    if (state.view === 'main' || state.view === 'day') views[state.view].softkeys();
  }

  // Какой кнопкой обновлять вручную (настройка «Кнопка обновления»)
  function centerRefreshes() { return settings.rkey === 'center0' || settings.rkey === 'center'; }
  function refreshKey() { return settings.rkey === 'center0' ? '0' : (settings.rkey === 'center' ? '' : settings.rkey); }
  // Подпись центральной софт-клавиши там, где она не открывает день
  function refreshLabel() {
    if (busy()) return t('sk_busy');
    return centerRefreshes() ? t('refresh') : t('skKeyHint', refreshKey());
  }

  // Ручное обновление: ничего не перекрывает и не сбрасывает прокрутку.
  // Прогресс — на центральной софт-клавише и в строке статуса.
  function refreshNow() {
    var entry = currentEntry();
    if (!entry) return;
    var pending = entry.geo && resolveGeo(true, true);
    if (!pending && entry.loc) loadWeather(entry.loc, true);
    renderStatus();
    refreshSoftkeys();
  }

  function distKm(a, b, c, d) {
    var r = Math.PI / 180, x = (d - b) * r * Math.cos((a + c) / 2 * r), y = (c - a) * r;
    return Math.sqrt(x * x + y * y) * 6371;
  }

  // Местоположение. Название места запрашиваем, только если сдвинулись > 5 км или сменился язык.
  // Возвращает true, если запрос места начат: тогда погода загрузится после него (один раз).
  // forceFix — нужна свежая точка (ручное обновление); wxForce — потом принудительно обновить погоду.
  var geoSeq = 0, geoWatchdog = null;
  function resolveGeo(forceFix, wxForce) {
    if (!settings.geo) return false;
    if (!navigator.geolocation) { state.geoStatus = 'unsupported'; return false; }
    if (state.geoStatus === 'locating') return true;
    if (settings.ttl < 0 && !forceFix && geoLoc) return false; // «только вручную»: место само не ищем
    var recent = geoLoc && geoLoc.lang === lang() && Date.now() - geoLoc.ts < 30 * MIN;
    if (recent && !forceFix) { state.geoStatus = 'ok'; return false; }

    var seq = ++geoSeq;
    state.geoStatus = 'locating';
    // Завершение ровно один раз: поздние ответы и сторож игнорируются
    var settle = function (ok) {
      if (seq !== geoSeq) return;
      geoSeq++;
      clearTimeout(geoWatchdog);
      state.geoStatus = (ok || geoLoc) ? 'ok' : 'error';
      var cur = currentEntry();
      if (cur && cur.geo && geoLoc) loadWeather(geoLoc, wxForce);
      if (state.view === 'main' && cur && cur.geo) {
        if (!ok) toast(t('locError'));
        renderMain(true);
      }
      refreshSoftkeys();
    };
    // Некоторые телефоны не вызывают ни один колбэк — не ждём вечно
    clearTimeout(geoWatchdog);
    geoWatchdog = setTimeout(function () { settle(false); }, 25000);

    navigator.geolocation.getCurrentPosition(function (pos) {
      if (seq !== geoSeq) return;
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      if (geoLoc && geoLoc.lang === lang() && distKm(geoLoc.lat, geoLoc.lon, lat, lon) < 5) {
        geoLoc.ts = Date.now();
        save('geo', geoLoc);
        settle(true);
        return;
      }
      Api.get().reverse(lat, lon, ctx()).then(function (loc) {
        if (seq !== geoSeq) return;
        geoLoc = {
          id: 'g' + lat.toFixed(2) + ',' + lon.toFixed(2),
          name: loc.name, admin: loc.admin, country: loc.country,
          lat: lat, lon: lon, ts: Date.now(), lang: lang()
        };
        save('geo', geoLoc);
        settle(true);
      }, function () { settle(false); });
    }, function () {
      settle(false);
    }, { enableHighAccuracy: false, timeout: 20000, maximumAge: forceFix ? 0 : 30 * MIN });
    return true;
  }

  /* ================= Уведомления о погоде ================= */

  function notifEntry() {
    var l = locations(), i = mainIndex();
    if (i >= 0 && l[i].loc) return l[i];
    for (var k = 0; k < l.length; k++) if (l[k].loc) return l[k];
    return null;
  }

  function iconUrl() { var a = document.createElement('a'); a.href = 'icons/icon-112.png'; return a.href; }

  function composeNotif(e, w) {
    w = upToDate(w);
    var c = w.cur, m = w.m, parts = [];
    var title = e.loc.name + ': ' + fTemp(c.temp) + (c.text ? ', ' + c.text : '');
    var evening = new Date().getHours() >= 18 && w.days[1];
    var d = evening ? w.days[1] : w.days[0];
    if (d) {
      var range = fTemp(d.max) + ' / ' + fTemp(d.min);
      parts.push(evening ? t('nb_tomorrow', range + (d.d.phrase ? ', ' + d.d.phrase.toLowerCase() : '')) : t('nb_today', range));
    }
    var age = Date.now() - w.t;
    if (age < 90 * MIN) {
      for (var i = 0; i < w.hours.length && i < 6; i++) {
        if (w.hours[i].pop >= 50) { parts.push(t('nb_precipAt', fHour(w.hours[i].dt))); break; }
      }
    }
    if (c.wind !== null) parts.push(t('nb_wind', fWind(c.wind, m) + (c.dir ? ' ' + c.dir : '')));
    if (age > 60 * MIN) parts.push(t('nb_old', stamp(w.t)));
    return { title: title, body: capitalize(parts.join(' · ')) };
  }

  function runNotification(manual) {
    var e = notifEntry();
    if (!e) {
      if (manual) toast(t('n_noCity'));
      return Promise.resolve(false);
    }
    var cached = weatherFor(e.loc);
    var p = ageOf(e.loc) < 20 * MIN ? Promise.resolve(cached) :
      fetchWeather(e.loc).then(null, function (err) { if (cached) return cached; throw err; });
    return p.then(function (w) {
      var msg = composeNotif(e, w);
      return Notify.show(msg.title, msg.body, iconUrl());
    }).then(function (ok) {
      if (manual) toast(t(ok ? 'n_sent' : 'n_denied'));
      return ok;
    }, function (err) {
      if (manual) toast(errText(err));
      return false;
    });
  }

  function reschedule() {
    return Notify.schedule(settings.notif).then(function (at) {
      settings.notif.nextAt = at ? at.getTime() : 0;
      saveSettings();
      if (state.view === 'notif') views.notif.updateNext();
      return at;
    }, function () { return null; });
  }

  var scheduleTimer = null;
  function rescheduleSoon() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(reschedule, 600);
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
    var h = $content.clientHeight, gap = 6;
    if (top < $content.scrollTop + gap || bottom - top > h) $content.scrollTop = Math.max(0, top - gap);
    else if (bottom > $content.scrollTop + h - gap) $content.scrollTop = bottom - h + gap;
  }

  function move(d) {
    var n = nav.idx + d;
    if (n < 0 || n >= nav.items.length) return false;
    nav.idx = n;
    state.digits = '';
    applyFocus();
    return true;
  }

  function go(name, arg) {
    state.view = name;
    state.digits = '';
    $content.scrollTop = 0;
    views[name].enter(arg);
  }

  // Строка списка: заголовок + значение
  function rowHtml(key, label, value, cls) {
    return '<div class="row f' + (cls ? ' ' + cls : '') + '" data-k="' + key + '"><div class="row-main"><div class="row-t">' +
      esc(label) + '</div>' + (value ? '<div class="row-s">' + esc(value) + '</div>' : '') + '</div></div>';
  }
  function indexOfKey(key) {
    var items = $content.querySelectorAll('.f');
    for (var i = 0; i < items.length; i++) if (items[i].getAttribute('data-k') === key) return i;
    return 0;
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
    if (entry.geo && !entry.loc) {
      if (state.geoStatus === 'unsupported') return t('noGeo');
      if (state.geoStatus === 'error') return t('locError') + '. ' + t('locHint');
      return t('locating');
    }
    var err = entry.loc && state.errors[cacheKey(entry.loc.id)];
    if (err) return errText(err);
    return t('loading');
  }

  function statusLine(entry, w) {
    var ck = cacheKey(entry.loc.id);
    if (state.loading[ck]) return t('updating');
    if (entry.geo && state.geoStatus === 'locating') return t('locating');
    var s = t('updated') + ' ' + stamp(w.t);
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
      var pop = Math.max(d.d.pop || 0, d.n ? d.n.pop || 0 : 0);
      rows += '<div class="drow f" data-role="day" data-i="' + i + '"' + (i === 0 ? ' data-anchor="sec-days"' : '') + '>' +
        '<span class="d-name">' + esc(dayLabel(d.date, i)) + '</span>' +
        Icons.svg(d.d.icon, 26) +
        '<span class="d-pop">' + (pop >= 20 ? pop + '%' : '') + '</span>' +
        '<span class="d-min">' + fTemp(d.min) + '</span>' +
        '<span class="bar"><i style="left:' + left.toFixed(1) + '%;width:' + width.toFixed(1) + '%"></i>' + dot + '</span>' +
        '<span class="d-max">' + fTemp(d.max) + '</span></div>';
    });
    return '<section class="card" id="sec-days"><h2>' + esc(t('daily', w.days.length)) + '</h2>' + rows + '</section>';
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
    var w = upToDate(weatherFor(entry.loc));
    setTheme(w ? Icons.theme(w.cur.icon, w.cur.day) : (entry.loc ? 'cloudy-day' : 'clear-day'));

    var html = heroHtml(entry, w, list);
    if (w) {
      if (w.headline) html += '<div class="headline">' + esc(w.headline) + '</div>';
      html += hourlyHtml(w) + dailyHtml(w) + detailsHtml(w) +
        '<div class="foot f">' + esc(Api.get().name) + ' · ' + esc(t('updated')) + ' ' + stamp(w.t) + '</div>';
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

  // mode: true — принудительно; 'open' — запуск/возврат в приложение; иначе — по сроку свежести
  function enterLocation(mode) {
    var entry = currentEntry();
    renderMain(false);
    if (!entry) return;
    var force = mode === true;
    if (mode === 'open' && settings.ttl === 0 && entry.loc && ageOf(entry.loc) > 2 * MIN) force = true;
    if (entry.geo) {
      if (!resolveGeo(mode === true, force) && geoLoc) loadWeather(geoLoc, force);
    } else {
      loadWeather(entry.loc, force);
    }
    renderStatus();
  }

  var views = {};

  views.main = {
    enter: function (mode) { enterLocation(mode || false); },
    softkeys: function () {
      var el = focused(), role = el && el.getAttribute('data-role');
      var c = role === 'day' ? t('open') : (role === 'add' ? t('add') : refreshLabel());
      softkeys(t('cities'), c, t('settings'));
      updateHours();
    },
    key: function (k, e) {
      var el = focused(), role = el && el.getAttribute('data-role');
      if (refreshKey() && k === refreshKey()) { refreshNow(); return; }
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
          else if (centerRefreshes()) refreshNow();
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
    render: function (keep) {
      var entry = currentEntry(), w = entry && upToDate(weatherFor(entry.loc));
      var prevIdx = keep ? nav.idx : 0, prevScroll = keep ? $content.scrollTop : 0;
      if (!w || !w.days[state.day]) { go('main'); return; }
      var d = w.days[state.day], m = w.m;
      setTheme(Icons.theme(d.d.icon, true));
      setTitle(dayTitle(d.date, state.day));
      var half = function (label, h, rain) {
        return '<section class="card f">' +
          '<div class="half-h">' + Icons.svg(h.icon, 40) + '<div><div class="half-l">' + esc(label) + '</div>' +
          '<div class="half-p">' + esc(h.long) + '</div></div></div>' +
          '<div class="kv"><span>' + esc(t('precip')) + '</span><b>' + fPct(h.pop) +
          (rain !== null && rain !== undefined ? ' · ' + esc(fRain(rain, m)) : '') + '</b></div>' +
          '<div class="kv"><span>' + esc(t('wind')) + '</span><b>' + esc(fWind(h.wind, m) + (h.dir ? ' ' + h.dir : '')) + '</b></div>' +
          '</section>';
      };
      $content.innerHTML = '<div class="dhead f">' + Icons.svg(d.d.icon, 64) +
        '<div><div class="dh-t">' + fTemp(d.max) + ' / ' + fTemp(d.min) + '</div>' +
        '<div class="dh-s">' + esc(t('feels')) + ' ' + fTemp(d.fmax) + ' / ' + fTemp(d.fmin) + '</div></div></div>' +
        half(t('allDay'), d.d, d.rain) +
        '<section class="card f">' +
        '<div class="kv"><span>' + esc(t('uv')) + '</span><b>' + (d.uv === null ? '--' : esc(d.uv + (d.uvText ? ' · ' + d.uvText : ''))) + '</b></div>' +
        '<div class="kv"><span>' + esc(t('sunrise')) + '</span><b>' + fClock(d.rise) + '</b></div>' +
        '<div class="kv"><span>' + esc(t('sunset')) + '</span><b>' + fClock(d.set) + '</b></div>' +
        '</section>';
      $content.scrollTop = 0;
      collect(prevIdx);
      if (keep) $content.scrollTop = prevScroll;
    },
    softkeys: function () {
      var entry = currentEntry(), w = entry && upToDate(weatherFor(entry.loc)), n = w ? w.days.length : 0;
      softkeys(state.day > 0 ? '◀' : '', refreshLabel(), state.day < n - 1 ? '▶' : '');
    },
    key: function (k, e) {
      var entry = currentEntry(), w = entry && upToDate(weatherFor(entry.loc)), n = w ? w.days.length : 0;
      if (refreshKey() && k === refreshKey()) { refreshNow(); return; }
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'ArrowLeft': case 'SoftLeft':
          if (state.day > 0) { state.day--; this.render(); } break;
        case 'ArrowRight': case 'SoftRight':
          if (state.day < n - 1) { state.day++; this.render(); } break;
        case 'Enter': if (centerRefreshes()) refreshNow(); break;
        case 'Backspace': e.preventDefault(); backToMain(); break;
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

  function removeCity(i) {
    var list = locations(), entry = list[i];
    if (!entry || entry.geo) return false;
    if (!window.confirm(t('confirmRemove', entry.loc.name))) return false;
    if (settings.main === entry.loc.id) setMain('');
    cities.splice(cities.indexOf(entry.loc), 1);
    save('cities', cities);
    if (state.idx > i) setIdx(state.idx - 1);
    else if (state.idx === i) setIdx(Math.max(0, Math.min(state.idx, locations().length - 1)));
    pruneCache(false);
    toast(t('removed'));
    return true;
  }

  views.cities = {
    enter: function (focusIdx) {
      setTheme('plain');
      setTitle(t('cities'));
      var html = '';
      locations().forEach(function (e, i) {
        var loc = e.loc, w = weatherFor(loc);
        var star = settings.main === entryId(e) ? '<span class="star">★</span>' : '';
        var sub = e.geo ? (loc ? loc.name : t('locating')) : [loc.admin, loc.country].filter(Boolean).join(', ');
        html += '<div class="row f" data-i="' + i + '">' +
          '<div class="row-main"><div class="row-t">' + star + (e.geo ? Icons.pin(14) : '') + esc(entryName(e)) + '</div>' +
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
      softkeys(t('add'), t('select'), i !== null ? t('options') : '');
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
          if (i !== null) this.options(+i);
          break;
        case 'Backspace': e.preventDefault(); go('main'); break;
        default: return;
      }
    },
    options: function (i) {
      var entry = locations()[i];
      if (!entry) return;
      var id = entryId(entry), isMain = settings.main === id;
      var back = function () { go('cities', i); };
      var items = [{
        label: isMain ? t('unsetMain') : t('makeMain'),
        fn: function () {
          setMain(isMain ? '' : id);
          toast(isMain ? t('mainCleared') : t('mainSet', entryName(entry)));
          back();
        }
      }];
      if (!entry.geo) {
        items.push({
          label: t('remove'),
          fn: function () { if (removeCity(i)) go('cities', Math.min(i, locations().length)); else back(); }
        });
      }
      go('menu', { title: entryName(entry), items: items, back: back });
    }
  };

  // Простое меню «Опции»
  views.menu = {
    enter: function (m) {
      state.menu = m;
      setTheme('plain');
      setTitle(m.title);
      var html = '';
      m.items.forEach(function (it, i) { html += rowHtml('m' + i, it.label, ''); });
      $content.innerHTML = html;
      collect(0);
    },
    softkeys: function () { softkeys('', t('select'), ''); },
    key: function (k, e) {
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'Enter': state.menu.items[nav.idx].fn(); break;
        case 'Backspace': case 'SoftLeft': e.preventDefault(); state.menu.back(); break;
        default: return;
      }
    }
  };

  /* ================= Экран: поиск города ================= */

  var search = { q: '', results: [], status: '', busy: false, token: 0 };

  views.search = {
    enter: function () {
      setTheme('plain');
      setTitle(t('addCity'));
      search.results = []; search.status = t('searchHint'); search.q = '';
      search.busy = false; search.token++; // ответы прошлых поисков игнорируются
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
      var self = this, token = ++search.token;
      Api.get().search(q, ctx()).then(function (list) {
        if (token !== search.token) return;
        search.busy = false;
        search.results = list;
        search.status = list.length ? '' : t('noResults');
        if (state.view === 'search') self.render(list.length ? 1 : 0);
      }, function (err) {
        if (token !== search.token) return;
        search.busy = false;
        search.status = errText(err);
        if (state.view === 'search') self.render(0);
      });
    },
    pick: function (r) {
      for (var i = 0; i < cities.length; i++) {
        var c = cities[i];
        if (c.id === r.id || (c.name === r.name && distKm(c.lat, c.lon, r.lat, r.lon) < 5)) {
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
    ttl: [0, 15, 30, 60, 180, -1],
    units: ['metric', 'imperial'],
    lang: ['auto', 'ru', 'uk', 'en'],
    geo: [true, false],
    rkey: ['center0', 'center', '0', '1', '5', '*', '#']
  };

  function mainOptions() {
    var o = [''];
    locations().forEach(function (e) { o.push(entryId(e)); });
    return o;
  }

  function optLabel(name, v) {
    switch (name) {
      case 'main':
        if (!v) return t('mainNone');
        var l = locations();
        for (var i = 0; i < l.length; i++) if (entryId(l[i]) === v) return entryName(l[i]);
        return t('mainNone');
      case 'ttl':
        if (v === 0) return t('ttlOpen');
        if (v < 0) return t('ttlManual');
        return t('ttlEvery', v < 60 ? v + ' ' + t('min') : (v / 60) + ' ' + t('hr'));
      case 'units': return v === 'metric' ? '°C' : '°F';
      case 'lang': return t('langNames')[v];
      case 'geo': return v ? t('on') : t('off');
      case 'rkey':
        if (v === 'center0') return t('rkCenter0');
        if (v === 'center') return t('rkCenter');
        return t('rkKey', v);
    }
    return String(v);
  }

  function notifSummary() {
    var n = settings.notif;
    if (!n.on) return t('off');
    var s;
    if (n.mode === 'times') {
      s = Notify.slots(n).map(function (m) { return clock(Math.floor(m / 60), m % 60); }).join(', ') || t('timeOff');
    } else {
      s = (n.every === 1 ? t('everyH1') : t('everyH', n.every)) + ', ' + pad(n.from) + ':00–' + pad(n.to) + ':00';
    }
    if (n.days !== 'daily') s += ' · ' + t(n.days === 'weekdays' ? 'daysWeekdays' : 'daysWeekends');
    return s;
  }

  // Что приложение делает, пока закрыто
  function bgSummary() {
    var n = settings.notif;
    if (!n.on || !Notify.supported()) return t('bgNone');
    var per = Notify.slots(n).length;
    return t(n.days === 'daily' ? 'bgNotif' : 'bgNotifDays', per);
  }

  function cycle(list, cur, d) {
    var i = list.indexOf(cur);
    if (i < 0) i = d > 0 ? -1 : 0;
    return list[(i + d + list.length) % list.length];
  }

  views.settings = {
    // focus — номер строки или её имя (data-k)
    enter: function (focus) {
      setTheme('plain');
      setTitle(t('settings'));
      var html = rowHtml('main', t('s_main'), optLabel('main', settings.main), 'cyc') +
        rowHtml('ttl', t('s_ttl'), optLabel('ttl', settings.ttl), 'cyc') +
        rowHtml('rkey', t('s_rkey'), optLabel('rkey', settings.rkey), 'cyc') +
        rowHtml('notif', t('s_notif'), notifSummary()) +
        rowHtml('bg', t('s_bg'), bgSummary(), 'info') +
        rowHtml('units', t('s_units'), optLabel('units', settings.units), 'cyc') +
        rowHtml('lang', t('s_lang'), optLabel('lang', settings.lang), 'cyc') +
        rowHtml('geo', t('s_geo'), optLabel('geo', settings.geo), 'cyc') +
        rowHtml('about', t('s_about'), '');
      $content.innerHTML = html;
      collect(typeof focus === 'string' ? indexOfKey(focus) : (focus || 0));
    },
    softkeys: function () {
      var el = focused(), k = el && el.getAttribute('data-k');
      softkeys('', k === 'bg' ? '' : (k === 'about' || k === 'notif') ? t('open') : t('change'), '');
    },
    change: function (name, d) {
      if (name === 'main') {
        setMain(cycle(mainOptions(), settings.main, d));
        var mi = mainIndex();
        if (mi >= 0) setIdx(mi);
      } else {
        var next = cycle(OPTS[name], settings[name], d);
        if (name === 'geo' && next !== settings.geo) {
          setIdx(Math.max(0, state.idx + (next ? 1 : -1)));
          if (!next && settings.main === 'geo') settings.main = '';
          if (next) state.geoStatus = 'idle';
        }
        settings[name] = next;
        saveSettings();
        if (name === 'ttl') { stopStaleTimer(); startStaleTimer(); }
        if (name === 'units' || name === 'lang') { state.errors = {}; pruneCache(false); }
      }
      this.enter(name);
    },
    key: function (k, e) {
      var el = focused(), name = el && el.getAttribute('data-k');
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'ArrowLeft': case 'ArrowRight': case 'Enter':
          if (name === 'notif') { if (k === 'Enter') go('notif'); }
          else if (name === 'about') { if (k === 'Enter') go('about'); }
          else if (name && name !== 'bg') this.change(name, k === 'ArrowLeft' ? -1 : 1);
          break;
        case 'Backspace': e.preventDefault(); go('main'); break;
        default: return;
      }
    }
  };

  /* ================= Экран: уведомления ================= */

  var EVERY = [1, 2, 3, 4, 6, 12];
  var DAYS = ['daily', 'weekdays', 'weekends'];

  // Шаг времени 30 минут; между 23:30 и 00:00 — «не задано»
  function stepTime(v, d) {
    var m = Notify.parseTime(v);
    if (m < 0) return d > 0 ? '08:00' : '20:00';
    var n = d > 0 ? Math.floor(m / 30) * 30 + 30 : Math.ceil(m / 30) * 30 - 30;
    if (n >= 1440 || n < 0) return '';
    return pad(Math.floor(n / 60)) + ':' + pad(n % 60);
  }

  function nextLabel() {
    var n = settings.notif;
    if (!n.on) return t('off');
    if (!Notify.supported()) return '—';
    var at = Notify.nextTime(n, new Date());
    if (!at) return t('n_none');
    var today = new Date(), tom = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    var day = at.toDateString() === today.toDateString() ? t('today') :
      at.toDateString() === tom.toDateString() ? t('tomorrow') : t('days')[at.getDay()];
    return day + ', ' + clock(at.getHours(), at.getMinutes());
  }

  views.notif = {
    enter: function (focus) {
      var n = settings.notif;
      setTheme('plain');
      setTitle(t('s_notif'));
      var html = rowHtml('on', t('n_on'), n.on ? t('on') : t('off'), 'cyc') +
        rowHtml('mode', t('n_mode'), t(n.mode === 'times' ? 'modeTimes' : 'modeInterval'), 'cyc');
      if (n.mode === 'times') {
        for (var i = 0; i < 4; i++) html += rowHtml('t' + i, t('n_time', i + 1), this.value('t' + i), 'cyc');
      } else {
        html += rowHtml('every', t('n_every'), this.value('every'), 'cyc') +
          rowHtml('from', t('n_from'), this.value('from'), 'cyc') +
          rowHtml('to', t('n_to'), this.value('to'), 'cyc');
      }
      var ne = notifEntry();
      html += rowHtml('days', t('n_days'), this.value('days'), 'cyc') +
        rowHtml('city', t('n_city'), ne ? entryName(ne) + (ne.geo && ne.loc ? ' (' + ne.loc.name + ')' : '') : t('n_noCity'), 'cyc') +
        '<div class="row f info" data-k="next"><div class="row-main"><div class="row-t">' + esc(t('n_next')) +
        '</div><div class="row-s" id="n-next">' + esc(nextLabel()) + '</div></div></div>' +
        rowHtml('test', t('n_test'), '', 'action');
      if (n.mode === 'times') html += '<div class="hint">' + esc(t('n_timeHint')) + '</div>';
      html += '<div class="hint">' + esc(t('n_battery')) + '</div>';
      if (!Notify.supported()) html += '<div class="hint warn">' + esc(t('n_unsupported')) + '</div>';
      $content.innerHTML = html;
      collect(typeof focus === 'string' ? indexOfKey(focus) : 0);
    },
    // Значение строки, с учётом набираемых цифр
    value: function (k) {
      var n = settings.notif, buf = state.digits, el = focused();
      var typing = buf && el && el.getAttribute('data-k') === k;
      if (k === 'every') return n.every === 1 ? t('everyH1') : t('everyH', n.every);
      if (k === 'from' || k === 'to') {
        if (typing) return (buf + '__').slice(0, 2) + ':00';
        return pad(n[k]) + ':00';
      }
      if (k.charAt(0) === 't') {
        if (typing) { var s = (buf + '____').slice(0, 4); return s.slice(0, 2) + ':' + s.slice(2); }
        return n.times[+k.charAt(1)] || t('timeOff');
      }
      if (k === 'days') return t({ daily: 'daysDaily', weekdays: 'daysWeekdays', weekends: 'daysWeekends' }[n.days]);
      return '';
    },
    updateRow: function (k) {
      var items = $content.querySelectorAll('.f');
      var row = items[indexOfKey(k)], sub = row && row.querySelector('.row-s');
      if (sub) sub.textContent = this.value(k);
    },
    updateNext: function () { var el = $('n-next'); if (el) el.textContent = nextLabel(); },
    softkeys: function () {
      var el = focused(), k = el && el.getAttribute('data-k');
      softkeys('', k === 'test' ? t('n_test') : (k === 'next' ? '' : t('change')), '');
    },
    commit: function (focusKey, rerender) {
      saveSettings();
      if (rerender) this.enter(focusKey); else { this.updateRow(focusKey); this.updateNext(); }
      rescheduleSoon();
    },
    change: function (k, d) {
      var n = settings.notif;
      state.digits = '';
      switch (k) {
        case 'on':
          n.on = !n.on;
          if (n.on) Notify.permission(); // спросить разрешение сейчас, а не в фоне
          return this.commit(k, true);
        case 'mode': n.mode = n.mode === 'times' ? 'interval' : 'times'; return this.commit(k, true);
        case 'every': n.every = cycle(EVERY, n.every, d); break;
        case 'from': case 'to': n[k] = (n[k] + d + 24) % 24; break;
        case 'days': n.days = cycle(DAYS, n.days, d); break;
        case 'city':
          setMain(cycle(mainOptions(), settings.main, d));
          return this.commit(k, true);
        default:
          if (/^t\d$/.test(k)) { var i = +k.charAt(1); n.times[i] = stepTime(n.times[i], d); break; }
          return;
      }
      this.commit(k, false);
    },
    // Ввод времени цифрами: 2 цифры для часа, 4 для ЧЧММ
    digit: function (k, ch) {
      var need = (k === 'from' || k === 'to') ? 2 : 4;
      state.digits += ch;
      if (state.digits.length >= need) {
        var b = state.digits, n = settings.notif;
        state.digits = '';
        if (need === 2) { if (+b < 24) n[k] = +b; }
        else if (+b.slice(0, 2) < 24 && +b.slice(2) < 60) n.times[+k.charAt(1)] = b.slice(0, 2) + ':' + b.slice(2);
        this.commit(k, false);
        return;
      }
      this.updateRow(k);
    },
    key: function (k, e) {
      var el = focused(), name = el && el.getAttribute('data-k');
      if (/^[0-9]$/.test(k) && name && (name === 'from' || name === 'to' || /^t\d$/.test(name))) {
        this.digit(name, k);
        return;
      }
      switch (k) {
        case 'ArrowUp': move(-1); break;
        case 'ArrowDown': move(1); break;
        case 'ArrowLeft': case 'ArrowRight': case 'Enter':
          if (name === 'test') { if (k === 'Enter') runNotification(true); }
          else if (name && name !== 'next') this.change(name, k === 'ArrowLeft' ? -1 : 1);
          break;
        case 'Backspace':
          e.preventDefault();
          if (state.digits) { state.digits = state.digits.slice(0, -1); this.updateRow(name); break; }
          go('settings', 'notif');
          break;
        default: return;
      }
    }
  };

  views.about = {
    enter: function () {
      setTheme('plain');
      setTitle(t('helpTitle'));
      var html = '<section class="card f">';
      // строка 2 — центральная клавиша, строка 3 — отдельная кнопка обновления
      t('help').forEach(function (h, i) {
        var keyName = h[0];
        if (i === 3) { keyName = refreshKey(); if (!keyName) return; }
        else if (i === 2 && !centerRefreshes()) h = [h[0], t('helpCenterOpen')];
        html += '<div class="kv"><span>' + esc(h[1]) + '</span><b>' + esc(keyName) + '</b></div>';
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
        case 'Backspace': case 'Enter': e.preventDefault(); go('settings', 'about'); break;
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
    if (!state.view) return;
    var k = normKey(e);
    var inInput = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (k === 'ArrowUp' || k === 'ArrowDown') e.preventDefault();
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !inInput) e.preventDefault();
    if (k === 'SoftLeft' || k === 'SoftRight') e.preventDefault();
    var v = views[state.view];
    if (v && v.key) v.key(k, e);
  });

  /* ================= Жизненный цикл ================= */

  var started = false, hiddenAt = 0, staleTimer = null, bgJobs = 0;

  // Пока приложение на экране — раз в 5 минут проверяем, не устарели ли данные (запроса нет, если свежие)
  function checkStale() {
    if (state.view !== 'main') return;
    var e = currentEntry();
    if (e && e.loc) loadWeather(e.loc, false);
  }
  // В режимах «только при открытии» и «вручную» таймера нет вообще; в фоне — тоже нет
  function startStaleTimer() {
    if (!staleTimer && settings.ttl > 0 && !document.hidden) staleTimer = setInterval(checkStale, 5 * MIN);
  }
  function stopStaleTimer() { clearInterval(staleTimer); staleTimer = null; }

  function start() {
    if (started) return;
    started = true;
    document.documentElement.lang = lang();
    document.title = t('appName');
    var mi = mainIndex();
    if (mi >= 0) setIdx(mi);
    go('main', 'open');
    startStaleTimer();
    // будильник переставляем после отрисовки, чтобы не тормозить запуск
    setTimeout(function () {
      pruneCache(false);
      if (settings.notif.on) reschedule(); else Notify.clear();
    }, 1500);
  }

  // Фоновый запуск (будильник, закрытое уведомление): сделать дело и закрыться
  function finishBackground() {
    if (bgJobs > 0 || started || !document.hidden) return;
    setTimeout(function () { if (!started && document.hidden && bgJobs === 0) window.close(); }, 500);
  }

  var handledAlarms = {};
  function onAlarm(data) {
    var at = data && data.at;
    if (at) { if (handledAlarms[at]) return; handledAlarms[at] = 1; } // дубль того же будильника
    bgJobs++;
    // Не даём телефону уснуть посреди загрузки (экран при этом не включается)
    var lock = null;
    try { lock = navigator.requestWakeLock ? navigator.requestWakeLock('cpu') : null; } catch (e) { lock = null; }
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      clearTimeout(safety);
      try { if (lock) lock.unlock(); } catch (e) { /* ignore */ }
      bgJobs--;
      finishBackground();
    };
    var safety = setTimeout(finish, 45000);
    // ignoreTimezone: будильник срабатывает по местному времени; учитываем смену часового пояса
    var shift = (data && typeof data.tz === 'number') ? (new Date().getTimezoneOffset() - data.tz) * MIN : 0;
    var late = at && Date.now() - (at + shift) > 2 * 60 * MIN; // телефон был выключен — не шлём старое
    // Сначала ставим следующий будильник: если систему закроют посреди загрузки, расписание не потеряется
    reschedule().then(function () {
      return (late || !settings.notif.on) ? null : runNotification(false);
    }).then(finish, finish);
  }

  if (navigator.mozSetMessageHandler) {
    try {
      navigator.mozSetMessageHandler('alarm', function (a) {
        if (a && a.data && a.data.type === Notify.TYPE) onAlarm(a.data);
      });
      // Сообщение приходит и при нажатии, и при закрытии уведомления
      navigator.mozSetMessageHandler('notification', function (m) {
        if (m && m.clicked) Notify.launchSelf();
        else finishBackground();
      });
    } catch (e) { /* ignore */ }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); stopStaleTimer(); return; }
    if (!started) { start(); return; }
    startStaleTimer();
    if (Date.now() - hiddenAt < MIN) { checkStale(); return; }
    // Вернулись в приложение: показать основной город и обновить по настройке
    var mi = mainIndex();
    if (mi >= 0 && state.view !== 'search' && state.view !== 'notif') {
      setIdx(mi);
      state.hour = 0;
      go('main', 'open');
    } else if (state.view === 'main') {
      enterLocation('open');
    }
  });

  // Любой запуск без показа на экране (будильник, закрытое уведомление) — фоновый:
  // интерфейс не рисуем, геолокацию не трогаем. Системное сообщение приходит асинхронно;
  // если за 20 с ничего не пришло — просто закрываемся. Откроет пользователь — сработает start().
  if (document.hidden) setTimeout(finishBackground, 20000);
  else start();
})();
