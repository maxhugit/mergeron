#!/bin/sh
set -u
PROXY_NETWORK="${MERGERON_PROXY_NETWORK:-mergeron-proxy}"

PID_FILE="${MERGERON_NETWORK_PID_FILE:-/var/run/mergeron-network-reconciler.pid}"
RETRY_DELAY="${MERGERON_NETWORK_RETRY_DELAY:-5}"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

network_exists() {
  docker network inspect "$1" >/dev/null 2>&1
}

container_has_network() {
  docker container inspect \
    --format "{{if index .NetworkSettings.Networks \"$2\"}}yes{{end}}" \
    "$1" 2>/dev/null | grep -qx yes
}

container_has_alias() {
  docker container inspect \
    --format "{{with index .NetworkSettings.Networks \"$2\"}}{{range .Aliases}}{{println .}}{{end}}{{end}}" \
    "$1" 2>/dev/null | grep -Fxq "$3"
}

ensure_connection() {
  container="$1"
  network="$2"

  if ! container_exists "$container"; then
    log "Conteneur absent, raccordement différé: $container"
    return 1
  fi

  if ! network_exists "$network"; then
    log "Réseau absent, raccordement différé: $network"
    return 1
  fi

  aliases_complete=true
  for alias_name in $required_aliases; do
    if ! container_has_alias "$container" "$network" "$alias_name"; then
      aliases_complete=false
    fi
  done

  if container_has_network "$container" "$network"; then
    if [ "$aliases_complete" = true ]; then
      return 0
    fi
    if ! docker network disconnect "$network" "$container"; then
      log "Échec de la correction des alias: $container -> $network"
      return 1
    fi
  fi

  set -- docker network connect
  for alias_name in $required_aliases; do
    set -- "$@" --alias "$alias_name"
  done
  set -- "$@" "$network" "$container"

  if "$@"; then
    log "Réseau et alias raccordés: $container -> $network ($required_aliases)"
    return 0
  fi

  log "Échec du raccordement: $container -> $network"
  return 1
}

reconcile_container() {
  container_result=0
  case "$1" in
    mergeron|mergeron-ui)
      required_aliases="mergeron mergeron-ui"
      ensure_connection "$1" mergeron-isolated || container_result=1
      ensure_connection "$1" mergeron-admin || container_result=1
      ;;
    mergeron-ingress)
      required_aliases="mergeron-ingress"
      ensure_connection "$1" mergeron-isolated || container_result=1
      ensure_connection "$1" "$PROXY_NETWORK" || container_result=1
      ;;
    mergeron-squid)
      required_aliases="mergeron-squid"
      ensure_connection "$1" mergeron-isolated || container_result=1
      ensure_connection "$1" mergeron-external || container_result=1
      ;;
    *)
      return 0
      ;;
  esac
  return "$container_result"
}

reconcile_all() {
  all_result=0
  reconcile_container mergeron-squid || all_result=1
  if container_exists mergeron; then
    reconcile_container mergeron || all_result=1
  elif container_exists mergeron-ui; then
    reconcile_container mergeron-ui || all_result=1
  fi
  reconcile_container mergeron-ingress || all_result=1
  return "$all_result"
}

run_watch() {
  if [ -f "$PID_FILE" ]; then
    existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    existing_command="$(ps -p "$existing_pid" -o args= 2>/dev/null || true)"
    if [ -n "$existing_pid" ] && [ "$existing_command" = "$0 watch" ]; then
      log "Le réconciliateur est déjà actif (PID $existing_pid)."
      return 0
    fi
  fi

  printf '%s\n' "$$" > "$PID_FILE"
  trap 'rm -f "$PID_FILE"' EXIT
  trap 'exit 0' HUP INT TERM

  log "Surveillance des réseaux DockerMan démarrée."
  while :; do
    if docker info >/dev/null 2>&1; then
      reconcile_all || true
    fi
    sleep "$RETRY_DELAY"
  done
}

case "${1:-once}" in
  once)
    reconcile_all
    ;;
  watch)
    run_watch
    ;;
  *)
    echo "Usage: $0 [once|watch]" >&2
    exit 2
    ;;
esac
