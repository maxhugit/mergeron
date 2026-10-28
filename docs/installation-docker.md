# Installer Mergeron sur Docker

Prérequis : hôte **Linux amd64**, Docker et, pour la variante Compose, Docker
Compose v2. Le noyau doit permettre le sandbox Bubblewrap non privilégié ;
Docker Desktop n’est pas une validation de production. Les images publiées et
les outils épinglés ciblent actuellement amd64 : l’indépendance du panneau hôte
ne signifie pas qu’une image ARM est publiée.

Utiliser des images contenant ce parcours : les changements de `main` sont
disponibles sur `edge` après publication ; `latest` ne les reçoit qu’avec une
nouvelle version stable. Pour la recette, utiliser le profil isolé de développement
et les deux images `edge`, sans remplacer les images de production.

Choisir une racine persistante et un CIDR administratif libre. Les valeurs
`/srv/mergeron`, `mergeron-proxy` et `172.30.44.0/28` sont des exemples modifiables.
Précréer le réseau externe choisi et y raccorder votre reverse proxy HTTPS.
Ne jamais connecter directement le backend au proxy public ni publier son
port 8172. Voir [le contrat portable](installation-portable.md).

## Variante Manager

Pour une installation **neuve**, adapter les valeurs puis lancer :

```sh
MERGERON_STATE_ROOT=/srv/mergeron/state
mkdir -p "$MERGERON_STATE_ROOT/manager-run" "$MERGERON_STATE_ROOT/manager-state"
docker network create mergeron-proxy
docker run -d --name mergeron-manager --restart unless-stopped \
  --network none --read-only --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_READ_SEARCH \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=8m --pids-limit 64 --memory 128m --cpus 0.25 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  --mount "type=bind,src=$MERGERON_STATE_ROOT,dst=/host-state" \
  --mount "type=bind,src=$MERGERON_STATE_ROOT/manager-run,dst=/run/mergeron-manager" \
  --mount "type=bind,src=$MERGERON_STATE_ROOT/manager-state,dst=/var/lib/mergeron-manager" \
  -e MERGERON_STATE_ROOT="$MERGERON_STATE_ROOT" \
  -e MERGERON_STACK_PREFIX=mergeron -e MERGERON_STACK_ENVIRONMENT=production \
  -e MERGERON_PROXY_NETWORK=mergeron-proxy -e MERGERON_HOST_INTEGRATION=none \
  -e MERGERON_AUTH_MODE=native -e MERGERON_ADMIN_SUBNET=172.30.44.0/28 \
  -e MERGERON_WEBUI_URL=https://mergeron.example.com \
  -e MERGERON_APP_IMAGE=ghcr.io/maxhugit/mergeron:latest \
  -e MERGERON_INSTALL_ENABLED=true ghcr.io/maxhugit/mergeron-manager:latest
```

Ne pas recréer un réseau déjà existant. Le socket Docker donne des privilèges
importants malgré son montage `readonly` : le Manager peut piloter l’API Docker
et doit rester privé. Consulter ses journaux et sa santé avec Docker.
Après recette, recréer **uniquement le conteneur Manager** avec la même commande
et `MERGERON_INSTALL_ENABLED=false`, sans supprimer ses dossiers ni les dépendances.
Conserver cette définition dans votre outil de déploiement.

Le Manager prépare uniquement les éléments manquants ; si une ressource est
incompatible, corriger la configuration plutôt que supprimer les données.
L’authentification native doit être provisionnée avant ouverture publique, selon
[la procédure d’initialisation](installation-portable.md#authentification-sans-authentik).
Aucun administrateur ou projet n’est créé automatiquement.

## Variante Compose

Copier `deployment/compose.yml`, `deployment/config/` et `deployment/.env.example`
dans un dossier privé. Nommer le fichier d’environnement `.env`, régler
`DEPLOY_ROOT` sur ce dossier et adapter `STATE_ROOT` ainsi que les autres valeurs.
Conserver `MERGERON_INSTALL_ENABLED=false` : Compose est ici le propriétaire.

### Préparer les données et secrets

Ces commandes concernent une installation **neuve**, jamais une restauration
ou une mise à jour. Pour l’existant, réutiliser les fichiers et valeurs actuels :
ne pas régénérer ses jetons.

```sh
STATE=/srv/mergeron/state
mkdir -p "$STATE/home" "$STATE/workspace" "$STATE/logs" "$STATE/ssh" \
  "$STATE/appdata" "$STATE/manager-run" "$STATE/manager-state"
openssl rand -hex 48 > "$STATE/backend-token.txt"
cp "$STATE/backend-token.txt" "$STATE/backend-token-nginx.txt"
install -m 440 /dev/null "$STATE/openai-api-key.txt"
chown -R 11002:11002 "$STATE/home" "$STATE/workspace" "$STATE/logs" "$STATE/ssh" "$STATE/appdata"
chown 11002:11002 "$STATE/backend-token.txt"
chown 0:0 "$STATE/backend-token-nginx.txt"
chgrp 11001 "$STATE/openai-api-key.txt"
chmod 400 "$STATE/backend-token.txt" "$STATE/backend-token-nginx.txt"
chmod 700 "$STATE/ssh"
```

La clé OpenAI peut rester vide si cette fonction n’est pas utilisée. Les deux
fichiers de jeton backend doivent contenir la même valeur. Ne pas versionner les
secrets, les clés SSH ou les données persistantes.

```sh
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml pull
docker compose --env-file .env -f compose.yml up -d
docker compose --env-file .env -f compose.yml ps
```

Le proxy choisi doit rejoindre `MERGERON_PROXY_NETWORK` et cibler l’ingress sur 8080. En mode natif, sélectionner `MERGERON_AUTH_MODE=native` et
`MERGERON_NGINX_TEMPLATE=nginx.native.conf.template`. Pour le contrôle proxy
historique, choisir explicitement son modèle et vérifier ses prérequis.
Exécuter [la recette de sécurité](installation-portable.md#recette-avant-exposition)
avant l’ouverture publique. Les [adaptations facultatives](adapters/README.md)
ajoutent seulement les paramètres propres à un panneau d’administration.

## Navigateur optionnel géré

Le [navigateur annoté](navigateur-annote.md#installation-optionnelle) ajoute un
service isolé, sans port hôte ni montage des données applicatives. Depuis le
Manager 0.5.1, `MERGERON_MANAGE_BROWSER=true` permet d’inclure explicitement ce
service préexistant dans l’inventaire et les transactions, également en
production. Sans cette option, la topologie existante reste inchangée.
Le réseau de contrôle doit rester interne ; le Manager refuse toute transaction
si le navigateur rejoint un réseau supplémentaire ou perd ses protections.
