#!/bin/sh
# Сборка пакета для установки на KaiOS.
#   ./build.sh                       — обычная сборка
#   ACCUWEATHER_KEY=xxxx ./build.sh  — ключ AccuWeather вшивается только в архив, не в репозиторий
#   (Open-Meteo ключ не нужен — он выбран по умолчанию)
set -e
cd "$(dirname "$0")"
OUT=dist
TMP="$OUT/app"
rm -rf "$OUT"
mkdir -p "$TMP"
cp -r index.html manifest.webapp manifest.webmanifest css js icons "$TMP/"
if [ -n "$ACCUWEATHER_KEY" ]; then
  sed -i.bak "s|accuweather: ''|accuweather: '$ACCUWEATHER_KEY'|" "$TMP/js/config.js"
  rm -f "$TMP/js/config.js.bak"
  echo "Ключ AccuWeather вшит в сборку."
fi
(cd "$TMP" && zip -qr ../application.zip .)
# Формат для OmniSD / установки из файла: metadata.json + application.zip
printf '{ "version": 1, "manifestURL": "app://weather.ivryab/manifest.webapp" }\n' > "$OUT/metadata.json"
(cd "$OUT" && zip -q weather-omnisd.zip application.zip metadata.json)
echo "Готово: $OUT/application.zip, $OUT/weather-omnisd.zip, папка $TMP (для WebIDE / appscmd)"
