/*
 * Источники погоды. Каждый провайдер приводит ответ к общему виду:
 *   { t, m, cur:{...}, hours:[...], days:[...], headline }
 * Чтобы добавить новый сервис, достаточно описать объект с методами
 * search / reverse / weather и добавить его в PROVIDERS.
 *
 * На KaiOS запросы идут через XMLHttpRequest({mozSystem: true}) — это обходит CORS
 * (разрешение systemXHR в манифесте, приложение типа privileged).
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
        else if (s === 401) reject(new ApiError('key', s));
        else if (s === 403) reject(new ApiError('forbidden', s));
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

  // Код погоды WMO -> номер иконки (иконки нумеруются как у AccuWeather)
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

    var dates = d.time || [];
    for (var j = 0; j < dates.length; j++) {
      var code = d.weather_code ? d.weather_code[j] : 3;
      var duv = at(d.uv_index_max, j);
      var phrase = ctx.wmo(code);
      out.days.push({
        date: dates[j],
        min: at(d.temperature_2m_min, j),
        max: at(d.temperature_2m_max, j),
        fmin: at(d.apparent_temperature_min, j),
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
    needsKey: false,
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
        hourly: 'temperature_2m,weather_code,precipitation_probability,is_day',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
          'sunrise,sunset,uv_index_max,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant',
        timezone: 'auto',
        forecast_days: 7,
        forecast_hours: 14,
        temperature_unit: metric ? 'celsius' : 'fahrenheit',
        wind_speed_unit: metric ? 'kmh' : 'mph',
        precipitation_unit: metric ? 'mm' : 'inch'
      })).then(function (r) { return omNormalize(r, ctx); });
    }
  };

  /* =================== AccuWeather (нужен API-ключ) =================== */

  var ACCU = 'https://dataservice.accuweather.com';

  function accuGet(path, params, ctx) {
    if (!ctx.key) return Promise.reject(new ApiError('nokey'));
    params.apikey = ctx.key;
    return getJSON(ACCU + path + '?' + qs(params));
  }

  function aval(o, unit) {
    if (!o) return null;
    if (unit && o[unit]) return num(o[unit].Value);
    return num(o.Value);
  }

  function accuLoc(r) {
    if (!r || !r.Key) return null;
    return {
      id: 'a' + r.Key,
      name: r.LocalizedName || r.EnglishName || '',
      admin: (r.AdministrativeArea && r.AdministrativeArea.LocalizedName) || '',
      country: (r.Country && r.Country.LocalizedName) || '',
      lat: r.GeoPosition ? r.GeoPosition.Latitude : null,
      lon: r.GeoPosition ? r.GeoPosition.Longitude : null,
      ids: { accu: String(r.Key) }
    };
  }

  function accuUv(list) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].Name === 'UVIndex') return { v: num(list[i].Value), t: list[i].Category || '' };
    }
    return null;
  }

  function accuHalf(h) {
    h = h || {};
    var w = h.Wind || {};
    return {
      icon: h.Icon,
      phrase: h.IconPhrase || '',
      long: h.LongPhrase || h.ShortPhrase || h.IconPhrase || '',
      pop: num(h.PrecipitationProbability),
      wind: w.Speed ? num(w.Speed.Value) : null,
      dir: (w.Direction && w.Direction.Localized) || ''
    };
  }

  function accuNormalize(cur, hourly, daily, metric) {
    var U = metric ? 'Metric' : 'Imperial';
    cur = (cur && cur[0]) || {};
    var wind = cur.Wind || {};
    var out = {
      t: Date.now(),
      m: metric,
      cur: {
        temp: aval(cur.Temperature, U),
        feels: aval(cur.RealFeelTemperature, U),
        text: cur.WeatherText || '',
        icon: cur.WeatherIcon || 7,
        day: cur.IsDayTime !== false,
        hum: num(cur.RelativeHumidity),
        wind: wind.Speed ? aval(wind.Speed, U) : null,
        dir: (wind.Direction && wind.Direction.Localized) || '',
        uv: num(cur.UVIndex),
        uvText: cur.UVIndexText || '',
        vis: aval(cur.Visibility, U),
        pres: aval(cur.Pressure, U),
        dew: aval(cur.DewPoint, U),
        cloud: num(cur.CloudCover),
        obs: cur.LocalObservationDateTime || ''
      },
      hours: [],
      days: [],
      headline: (daily && daily.Headline && daily.Headline.Text) || ''
    };

    (hourly || []).forEach(function (h) {
      out.hours.push({
        dt: h.DateTime || '',
        icon: h.WeatherIcon,
        temp: aval(h.Temperature),
        pop: num(h.PrecipitationProbability),
        day: h.IsDaylight !== false
      });
    });

    ((daily && daily.DailyForecasts) || []).forEach(function (d) {
      var t = d.Temperature || {}, rf = d.RealFeelTemperature || {}, uv = accuUv(d.AirAndPollen);
      out.days.push({
        date: d.Date || '',
        min: aval(t.Minimum),
        max: aval(t.Maximum),
        fmin: aval(rf.Minimum),
        fmax: aval(rf.Maximum),
        d: accuHalf(d.Day),
        n: accuHalf(d.Night),
        rain: null,
        rise: (d.Sun && d.Sun.Rise) || '',
        set: (d.Sun && d.Sun.Set) || '',
        uv: uv ? uv.v : null,
        uvText: uv ? uv.t : ''
      });
    });
    return out;
  }

  var accuweather = {
    id: 'accuweather',
    name: 'AccuWeather',
    needsKey: true,
    days: 5,

    search: function (q, ctx) {
      return accuGet('/locations/v1/cities/search', { q: q, language: ctx.accuLang }, ctx).then(function (list) {
        var out = [];
        (list || []).forEach(function (r) { var l = accuLoc(r); if (l) out.push(l); });
        return out.slice(0, 15);
      });
    },

    reverse: function (lat, lon, ctx) {
      return accuGet('/locations/v1/cities/geoposition/search', {
        q: lat.toFixed(4) + ',' + lon.toFixed(4), language: ctx.accuLang
      }, ctx).then(function (r) {
        var l = accuLoc(r);
        if (!l) throw new ApiError('server');
        return l;
      });
    },

    // Города, добавленные через другой сервис, получают ключ AccuWeather
    // по координатам (1 запрос, затем он сохраняется в loc.ids).
    weather: function (loc, ctx) {
      loc.ids = loc.ids || {};
      if (!loc.ids.accu && typeof loc.lat !== 'number') return Promise.reject(new ApiError('server'));
      var keyP = loc.ids.accu ? Promise.resolve(loc.ids.accu) :
        accuweather.reverse(loc.lat, loc.lon, ctx).then(function (l) { loc.ids.accu = l.ids.accu; return l.ids.accu; });
      return keyP.then(function (k) {
        k = encodeURIComponent(k);
        var p = { language: ctx.accuLang, details: 'true' };
        var pm = { language: ctx.accuLang, details: 'true', metric: ctx.metric ? 'true' : 'false' };
        return Promise.all([
          accuGet('/currentconditions/v1/' + k, p, ctx),
          accuGet('/forecasts/v1/hourly/12hour/' + k, pm, ctx),
          accuGet('/forecasts/v1/daily/5day/' + k, pm, ctx)
        ]);
      }).then(function (r) { return accuNormalize(r[0], r[1], r[2], ctx.metric); });
    }
  };

  var PROVIDERS = { openmeteo: openmeteo, accuweather: accuweather };

  W.WxApi = {
    Error: ApiError,
    list: ['openmeteo', 'accuweather'],
    get: function (id) { return PROVIDERS[id] || openmeteo; },
    wmoIcon: wmoIcon
  };
})(window);
