#!/bin/bash

moneda=$(osascript -e 'Tell application "System Events" to display dialog "¿Qué par quieres consultar?" default answer ""' -e 'text returned of result')

echo "🔍 Buscando historial para $moneda..."

curl -s https://bot-kraken-openai-production.up.railway.app/historial/$moneda | jq .

read -p "Pulsa ENTER para cerrar"