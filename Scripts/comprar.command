#!/bin/bash

par=$(osascript -e 'Tell application "System Events" to display dialog "Par (ej: ADAEUR)" default answer ""' -e 'text returned of result')
inv=$(osascript -e 'Tell application "System Events" to display dialog "¿Cuánto invertir (EUR)?" default answer "40"' -e 'text returned of result')
trail=$(osascript -e 'Tell application "System Events" to display dialog "Trailing Stop (%)?" default answer "6"' -e 'text returned of result')

echo "🛒 Enviando orden de compra para $par..."

curl -X POST https://bot-kraken-openai-production.up.railway.app/alerta \
-H "Content-Type: application/json" \
-d "{\"par\": \"$par\", \"inversion\": $inv, \"trailingStopPercent\": $trail}"

read -p "Pulsa ENTER para cerrar"