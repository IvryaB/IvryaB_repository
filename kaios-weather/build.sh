#!/bin/sh
# Сборка пакета для установки на KaiOS:  ./build.sh
# Результат: dist/weather-kaios-<версия>.zip — папка для WebIDE, пакет OmniSD и инструкция.
set -e
cd "$(dirname "$0")"
VER=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.webapp | head -1)
OUT=dist
PKG="$OUT/pkg"
APP="$PKG/weather-kaios"
rm -rf "$OUT"
mkdir -p "$APP"
cp -r index.html manifest.webapp manifest.webmanifest css js icons "$APP/"
# OmniSD / Wallace Toolbox: application.zip + metadata.json внутри zip
mkdir -p "$OUT/omnisd"
(cd "$APP" && zip -qrX ../../omnisd/application.zip .)
printf '{ "version": 1, "manifestURL": "app://weather.ivryab/manifest.webapp" }\n' > "$OUT/omnisd/metadata.json"
(cd "$OUT/omnisd" && zip -qX ../pkg/weather-omnisd.zip application.zip metadata.json)
cp INSTALL.txt "$PKG/УСТАНОВКА.txt"
(cd "$PKG" && zip -qrX "../weather-kaios-$VER.zip" .)
rm -rf "$OUT/omnisd"
echo "Готово: $OUT/weather-kaios-$VER.zip"
