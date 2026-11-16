/*
 * Источник погоды: Open-Meteo (бесплатно, без ключа) + OpenStreetMap для названий мест.
 * Ответ приводится к общему виду: { t, m, cur:{...}, hours:[...], days:[...], headline }.
 *
 * На KaiOS запросы идут через XMLHttpRequest({mozSystem: true}) — разрешение systemXHR
 * в манифесте (приложение типа privileged).
 */
(function (W) {
  'use strict';

  var TIMEOUT = 20000;

  function ApiError(type, status) {
    this.type = type;
    this.status = status || 0;
  }

  function qs(params) {
    var q = [];
    for (var k in params) {
      if (params.hasOwnProperty(k) && params[k] !== null && params[k] !== undefined) {
        q.push(k + '=' + encodeURIComponent(params[k]));
      }
    }
    return q.join('&');
  }

  function getJSON(url) {
    return new Promise(function (resolve, reject) {
      var xhr;
      try { xhr = new XMLHttpRequest({ mozSystem: true }); } catch (e) { xhr = new XMLHttpRequest(); }
      xhr.open('GET', url, true);
      xhr.timeout = TIMEOUT;
      xhr.onload = function () {
        var data = null;
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        var s = xhr.status;
        if (s >= 200 && s < 300 && data !== null) resolve(data);
        else if (s === 429 || s === 503) reject(new ApiError('limit', s));
        else if (s === 0) reject(new ApiError('net', s));
        else reject(new ApiError('server', s));
      };
      xhr.onerror = function () { reject(new ApiError('net')); };
      xhr.ontimeout = function () { reject(new ApiError('net')); };
      xhr.send();
    });
  }

  function num(v) { return (typeof v === 'number' && !isNaN(v)) ? v : null; }
  function at(arr, i) { return arr ? num(arr[i]) : null; }

  /* =================== Open-Meteo (бесплатно, без ключа) =================== */

  var OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var OM_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  var OSM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
  var PHOTON_REVERSE = 'https://photon.komoot.io/reverse';

  // Код погоды WMO -> номер иконки (внутренняя нумерация иконок 1–44, см. icons.js)
  function wmoIcon(c, day) {
    switch (c) {
      case 0: return day ? 1 : 33;
      case 1: return day ? 2 : 34;
      case 2: return day ? 3 : 35;
      case 3: return 7;
      case 45: case 48: return 11;
      case 51: case 53: case 55: return 12;
      case 56: case 57: case 66: case 67: return 26;
      case 61: case 63: case 65: case 82: return 18;
      case 71: case 73: case 75: return 22;
      case 77: return 19;
      case 80: case 81: return day ? 14 : 39;
      case 85: case 86: return day ? 21 : 43;
      case 95: case 96: case 99: return 15;
    }
    return 7;
  }

  // Название места по координатам (у Open-Meteo обратного геокодинга нет).
  // OpenStreetMap: Nominatim, запасной вариант — Photon. Вызывается редко
  // (только если сдвинулись больше чем на 5 км). При ошибке — просто координаты,
  // чтобы погода всё равно показалась.
  function reverseOSM(lat, lon, ctx) {
    var fallback = { name: lat.toFixed(2) + ', ' + lon.toFixed(2), admin: '', country: '' };
    var pick = function (name, admin, country) {
      if (!name) throw new ApiError('server');
      return { name: name, admin: admin && admin !== name ? admin : '', country: country || '' };
    };
    return getJSON(OSM_REVERSE + '?' + qs({
      format: 'jsonv2', lat: lat.toFixed(4), lon: lon.toFixed(4), zoom: 10, 'accept-language': ctx.lang
    })).then(function (r) {
      var a = r.address || {};
      return pick(a.city || a.town || a.village || a.hamlet || a.municipality || a.county || r.name, a.state, a.country);
    }).then(null, function () {
      return getJSON(PHOTON_REVERSE + '?' + qs({ lat: lat.toFixed(4), lon: lon.toFixed(4), limit: 1 })).then(function (r) {
        var p = (r.features && r.features[0] && r.features[0].properties) || {};
        return pick(p.city || p.town || p.village || p.county || p.name, p.state, p.country);
      });
    }).then(null, function () { return fallback; });
  }

  function omNormalize(r, ctx) {
    var metric = ctx.metric;
    var c = r.current || {}, cu = r.current_units || {}, h = r.hourly || {}, d = r.daily || {};
    var day = c.is_day !== 0;

    var vis = num(c.visibility);
    if (vis !== null) {
      var meters = cu.visibility === 'ft' ? vis * 0.3048 : vis;
      vis = metric ? meters / 1000 : meters / 1609.34;
    }
    var pres = num(c.pressure_msl);
    if (pres !== null && !metric) pres = pres * 0.02953; // гПа -> inHg
    var uv = num(c.uv_index);

    var out = {
      t: Date.now(),
      m: metric,
      off: num(r.utc_offset_seconds), // часовой пояс города — чтобы отличать «сегодня» от прошедших дней
      cur: {
        temp: num(c.temperature_2m),
        feels: num(c.apparent_temperature),
        text: ctx.wmo(c.weather_code),
        icon: wmoIcon(c.weather_code, day),
        day: day,
        hum: num(c.relative_humidity_2m),
        wind: num(c.wind_speed_10m),
        dir: ctx.compass(c.wind_direction_10m),
        uv: uv === null ? null : Math.round(uv),
        uvText: uv === null ? '' : ctx.uvText(uv),
        vis: vis,
        pres: pres,
        dew: num(c.dew_point_2m),
        cloud: num(c.cloud_cover),
        obs: c.time || ''
      },
      hours: [],
      days: [],
      headline: ''
    };

    // Часы начиная со следующего за текущим
    var nowHour = (c.time || '').substr(0, 13);
    var times = h.time || [];
    for (var i = 0; i < times.length && out.hours.length < 12; i++) {
      if (nowHour && times[i].substr(0, 13) <= nowHour) continue;
      out.hours.push({
        dt: times[i],
        icon: wmoIcon(h.weather_code ? h.weather_code[i] : 3, h.is_day ? h.is_day[i] !== 0 : true),
        temp: at(h.temperature_2m, i),
        pop: at(h.precipitation_probability, i),
        day: h.is_day ? h.is_day[i] !== 0 : true
      });
    }

    // Минимум — за ночь ПОСЛЕ дня (18:00 → 06:00), как в AccuWeather / Weather.com / Pixel:
    // «Вт 6° / 5°» = днём во вторник до 6°, ночью на среду до 5°. Календарный минимум суток —
    // это обычно раннее утро того же дня, и он сильно отличается от привычных приложений.
    function nightMin(arr, date) {
      if (!arr) return null;
      var start = times.indexOf(date + 'T18:00');
      if (start < 0) return null;
      var m = null;
      for (var k = start; k < start + 12 && k < arr.length; k++) {
        var v = num(arr[k]);
        if (v !== null && (m === null || v < m)) m = v;
      }
      return m;
    }

    var dates = d.time || [];
    for (var j = 0; j < dates.length; j++) {
      var nmin = nightMin(h.temperature_2m, dates[j]), nfmin = nightMin(h.apparent_temperature, dates[j]);
      var code = d.weather_code ? d.weather_code[j] : 3;
      var duv = at(d.uv_index_max, j);
      var phrase = ctx.wmo(code);
      out.days.push({
        date: dates[j],
        min: nmin !== null ? nmin : at(d.temperature_2m_min, j),
        max: at(d.temperature_2m_max, j),
        fmin: nfmin !== null ? nfmin : at(d.apparent_temperature_min, j),
        fmax: at(d.apparent_temperature_max, j),
        d: {
          icon: wmoIcon(code, true),
          phrase: phrase,
          long: phrase,
          pop: at(d.precipitation_probability_max, j),
          wind: at(d.wind_speed_10m_max, j),
          dir: ctx.compass(d.wind_direction_10m_dominant ? d.wind_direction_10m_dominant[j] : null)
        },
        n: null, // Open-Meteo не делит день на день/ночь
        rain: at(d.precipitation_sum, j),
        rise: d.sunrise ? d.sunrise[j] : '',
        set: d.sunset ? d.sunset[j] : '',
        uv: duv === null ? null : Math.round(duv),
        uvText: duv === null ? '' : ctx.uvText(duv)
      });
    }
    return out;
  }

  var openmeteo = {
    id: 'openmeteo',
    name: 'Open-Meteo',
    days: 7,

    search: function (q, ctx) {
      return getJSON(OM_GEO + '?' + qs({ name: q, count: 15, language: ctx.lang, format: 'json' })).then(function (r) {
        var out = [];
        ((r && r.results) || []).forEach(function (x) {
          if (typeof x.latitude !== 'number') return;
          out.push({
            id: 'om' + x.id, name: x.name || '', admin: x.admin1 || '', country: x.country || '',
            lat: x.latitude, lon: x.longitude, ids: {}
          });
        });
        return out;
      });
    },

    reverse: reverseOSM,

    weather: function (loc, ctx) {
      if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return Promise.reject(new ApiError('server'));
      var metric = ctx.metric;
      return getJSON(OM_FORECAST + '?' + qs({
        latitude: loc.lat.toFixed(4),
        longitude: loc.lon.toFixed(4),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,cloud_cover,' +
          'pressure_msl,wind_speed_10m,wind_direction_10m,dew_point_2m,visibility,uv_index',
        hourly: 'temperature_2m,apparent_temperature,weather_code,precipitation_probability,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
          'sunrise,sunset,uv_index_max,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant',
        timezone: 'auto',
        // 8 дней почасово: нужна ночь после 7-го дня; показываем 7 дней
        forecast_days: 8,
        temperature_unit: metric ? 'celsius' : 'fahrenheit',
        wind_speed_unit: metric ? 'kmh' : 'mph',
        precipitation_unit: metric ? 'mm' : 'inch'
      })).then(function (r) { return omNormalize(r, ctx); });
    }
  };

  // Сейчас источник один; чтобы добавить ещё, опишите объект как openmeteo
  // (id, name, days, search, reverse, weather) и верните его из get().
  W.WxApi = {
    Error: ApiError,
    get: function () { return openmeteo; },
    wmoIcon: wmoIcon
  };
})(window);
