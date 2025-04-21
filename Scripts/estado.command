#!/bin/bash

echo "📦 Consultando estado de operaciones..."

curl -s https://bot-kraken-openai-production.up.railway.app/estado | jq .

read -p "Pulsa ENTER para cerrar"