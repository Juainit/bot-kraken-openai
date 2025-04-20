#!/bin/bash

par=$(osascript -e 'Tell application "System Events" to display dialog "¿Qué par deseas vender?" default answer ""' -e 'text returned of result')

cd "$(dirname "$0")"
node venderManual.js "$par"

read -p "Pulsa ENTER para cerrar"