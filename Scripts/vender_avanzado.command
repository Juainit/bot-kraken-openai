#!/bin/bash

# Menú desplegable para tipo de venta
tipo=$(osascript -e 'choose from list {"mercado", "límite"} with prompt "¿Cómo quieres vender?" default items {"mercado"}')
tipo=$(echo $tipo | tr -d '{}"') # limpiar salida

# Si se cancela el diálogo
if [ "$tipo" == "false" ] || [ -z "$tipo" ]; then
  echo "❌ Cancelado por el usuario"
  exit 1
fi

# Solicitar el par
par=$(osascript -e 'text returned of (display dialog "¿Qué par quieres vender?" default answer "")')
if [ -z "$par" ]; then
  echo "❌ No se especificó ningún par"
  exit 1
fi

# Solicitar el porcentaje
porcentaje=$(osascript -e 'text returned of (display dialog "¿Qué porcentaje quieres vender?" default answer "100")')
if [ -z "$porcentaje" ]; then
  echo "❌ No se especificó porcentaje"
  exit 1
fi

# Si es límite, pedir el precio
if [ "$tipo" == "límite" ]; then
  precio=$(osascript -e 'text returned of (display dialog "¿A qué precio límite quieres vender?" default answer "")')
  if [ -z "$precio" ]; then
    echo "❌ No se especificó precio límite"
    exit 1
  fi
fi

# Enviar a servidor
echo "🚀 Enviando orden de venta $tipo para $par..."

# Armar JSON
if [ "$tipo" == "límite" ]; then
  json=$(jq -n --arg par "$par" --arg tipo "$tipo" --arg porcentaje "$porcentaje" --arg precio "$precio" \
    '{par: $par, tipo: $tipo, porcentaje: ($porcentaje | tonumber), precio: ($precio | tonumber)}')
else
  json=$(jq -n --arg par "$par" --arg tipo "$tipo" --arg porcentaje "$porcentaje" \
    '{par: $par, tipo: $tipo, porcentaje: ($porcentaje | tonumber)}')
fi

# Ejecutar curl
respuesta=$(curl -s -X POST http://localhost:3000/vender \
  -H "Content-Type: application/json" \
  -d "$json")

echo "$respuesta"
osascript -e 'display dialog "✅ Orden enviada.\nPulsa ENTER para cerrar" buttons {"OK"}'