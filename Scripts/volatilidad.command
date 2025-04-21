#!/bin/bash
cd "$(dirname "$0")/.."
clear
echo "🌀 Calculando volatilidad diaria media..."
node Scripts/volatilidad.js
echo "Pulsa ENTER para cerrar"
read