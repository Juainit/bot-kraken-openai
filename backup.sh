#!/bin/bash
export PGPASSWORD="oGaCnBFsBUlnePPStrsDgHYxbNXDApGR"
pg_dump -h shinkansen.proxy.rlwy.net -p 45439 -U postgres -d railway \
  --format=plain --clean --if-exists --no-owner --no-acl \
  > backup_$(date +%Y-%m-%d).sql