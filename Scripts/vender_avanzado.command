#!/bin/bash

echo "📋 Iniciando venta avanzada..."

par=$(osascript -e 'Tell application "System Events" to display dialog "¿Qué par deseas vender? (ej: TAOUSD)" default answer ""' -e 'text returned of result')
[ -z "$par" ] && echo "❌ Cancelado por el usuario" && exit

modo=$(osascript -e 'choose from list {"mercado", "limite"} with prompt "¿Tipo de orden?" default items {"mercado"}')
[ "$modo" = "false" ] && echo "❌ Cancelado por el usuario" && exit
modo=$(echo "$modo" | tr -d '{}"')  # limpia formato AppleScript

porcentaje=$(osascript -e 'Tell application "System Events" to display dialog "¿Qué porcentaje del balance deseas vender?" default answer "100"' -e 'text returned of result')
[ -z "$porcentaje" ] && echo "❌ Cancelado por el usuario" && exit

if [ "$modo" = "limite" ]; then
  precio=$(osascript -e 'Tell application "System Events" to display dialog "¿A qué precio límite deseas vender?" default answer "0.0"' -e 'text returned of result')
  [ -z "$precio" ] && echo "❌ Cancelado por el usuario" && exit

  json=$(jq -n --arg par "$par" --arg tipo "$modo" --arg porcentaje "$porcentaje" --arg precio "$precio" \
    '{pair:$par, tipo:$tipo, porcentaje:($porcentaje|tonumber), precioLimite:($precio|tonumber)}')
else
  json=$(jq -n --arg par "$par" --arg tipo "$modo" --arg porcentaje "$porcentaje" \
    '{pair:$par, tipo:$tipo, porcentaje:($porcentaje|tonumber)}')
fi

echo "🚀 Enviando orden de venta $modo para $par..."

curl -X POST https://bot-kraken-openai-production.up.railway.app/vender \
  -H "Content-Type: application/json" \
  -d "$json"

read -p "Pulsa ENTER para cerrar"