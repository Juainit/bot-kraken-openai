#!/bin/bash

opcion=$(osascript -e 'choose from list {"Ver estado", "Vender", "Comprar"} with prompt "¿Qué deseas hacer?" default items {"Ver estado"}')

if [[ "$opcion" == "Ver estado" ]]; then
    ./estado.command
elif [[ "$opcion" == "Vender" ]]; then
    ./vender.command
elif [[ "$opcion" == "Comprar" ]]; then
    ./comprar.command
else
    echo "🚫 Acción cancelada"
    read -p "Pulsa ENTER para cerrar"
fi