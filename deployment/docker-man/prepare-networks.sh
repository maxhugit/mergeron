#!/bin/sh
set -eu
PROXY_NETWORK="${MERGERON_PROXY_NETWORK:-mergeron-proxy}"

ensure_network() {
  name="$1"
  internal="$2"
  subnet="${3:-}"

  if docker network inspect "$name" >/dev/null 2>&1; then
    actual_driver="$(docker network inspect -f '{{.Driver}}' "$name")"
    actual_internal="$(docker network inspect -f '{{.Internal}}' "$name")"

    if [ "$actual_driver" != "bridge" ] || [ "$actual_internal" != "$internal" ]; then
      echo "Le réseau $name existe avec une configuration incompatible." >&2
      echo "Attendu: driver=bridge internal=$internal" >&2
      exit 1
    fi

    if [ -n "$subnet" ]; then
      actual_subnets="$(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$name")"
      if ! printf '%s\n' "$actual_subnets" | grep -Fx "$subnet" >/dev/null; then
        echo "Le réseau $name existe sans le sous-réseau attendu $subnet." >&2
        exit 1
      fi
    fi

    echo "Réseau déjà conforme: $name"
    return
  fi

  if [ "$internal" = "true" ]; then
    docker network create --driver bridge --internal "$name" >/dev/null
  elif [ -n "$subnet" ]; then
    docker network create --driver bridge --subnet "$subnet" "$name" >/dev/null
  else
    docker network create --driver bridge "$name" >/dev/null
  fi

  echo "Réseau créé: $name"
}

ensure_network mergeron-isolated true
ensure_network mergeron-external false
ensure_network mergeron-admin false 172.30.44.0/28

if ! docker network inspect "$PROXY_NETWORK" >/dev/null 2>&1; then
  echo "Le réseau partagé $PROXY_NETWORK est absent." >&2
  echo "Créez-le et raccordez-y le reverse proxy choisi avant de continuer." >&2
  exit 1
fi

echo "Réseau partagé présent: $PROXY_NETWORK"
