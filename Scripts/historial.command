#!/bin/bash

echo "📜 Historial completo de transacciones (requiere endpoint adicional)..."

curl -s https://bot-kraken-openai-production.up.railway.app/historial | jq .

read -p "Pulsa ENTER para cerrar"