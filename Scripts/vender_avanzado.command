#!/bin/bash

# Preguntar el par
par=$(osascript -e 'Tell application "System Events" to display dialog "¿Qué par deseas vender? (Ej: ADAEUR, TAOUSD...)" default answer ""' -e 'text returned of result' 2>/dev/null)

# Preguntar tipo de orden
tipo=$(osascript -e 'Tell application "System Events" to choose from list {"mercado", "limite"} with prompt "Selecciona el tipo de venta:"' 2>/dev/null)

if [ "$tipo" = "false" ]; then
  echo "Cancelado."
  exit 1
fi

tipo=${tipo:1:-1}  # Elimina paréntesis de la salida del diálogo

# Preguntar porcentaje
porcentaje=$(osascript -e 'Tell application "System Events" to display dialog "¿Qué porcentaje deseas vender? (Ej: 100 para todo)" default answer "100"' -e 'text returned of result' 2>/dev/null)

# Si es límite, preguntar precio límite
if [ "$tipo" = "limite" ]; then
  precioLimite=$(osascript -e 'Tell application "System Events" to display dialog "¿Precio límite?" default answer ""' -e 'text returned of result' 2>/dev/null)
fi

echo "🚀 Enviando orden de venta $tipo para $par..."

# Construir el JSON
json="{\"pair\":\"$par\",\"tipo\":\"$tipo\",\"porcentaje\":$porcentaje"
if [ "$tipo" = "limite" ]; then
  json="$json, \"precioLimite\":$precioLimite"
fi
json="$json}"

# Enviar la solicitud
curl -X POST https://bot-kraken-openai-production.up.railway.app/vender \
  -H "Content-Type: application/json" \
  -d "$json"

echo ""
read -p "Pulsa ENTER para cerrar"