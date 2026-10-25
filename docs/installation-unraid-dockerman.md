# Installation avec les formulaires Docker standard d'Unraid

Pour une nouvelle installation, utiliser d’abord
[le parcours Manager](installation-portable.md#manager--recommandé-sur-unraid) :
un seul XML, aucun formulaire sur les dépendances. Cette page décrit la méthode
manuelle historique, à ne pas utiliser simultanément avec ce parcours. Les trois
conteneurs apparaissent séparément dans l'onglet **Docker** d'Unraid et peuvent
être mis à jour avec l'action standard **Check for Updates / Update**.

Lire d’abord le
[comparatif des deux modes](choisir-mode-installation.md). DockerMan enregistre
les paramètres dans les modèles et formulaires Unraid. Toute modification de
chemin, variable, volume ou option avancée doit donc être appliquée au formulaire
du conteneur concerné. Le fichier Compose du dépôt n’est pas utilisé par ce mode.

Les trois formulaires conservent l'architecture de sécurité existante :

1. `mergeron-squid` filtre les accès sortants avec Squid ;
2. `mergeron` exécute l'application sans publier son port ;
3. `mergeron-ingress` relie Traefik/Authentik au backend isolé.

## 1. Installer les fichiers

Dans le terminal Unraid :

```bash
git clone https://github.com/maxhugit/mergeron.git /tmp/mergeron-install
mkdir -p /mnt/user/appdata/mergeron/config
cp -a /tmp/mergeron-install/deployment/config/. \
  /mnt/user/appdata/mergeron/config/
cp /tmp/mergeron-install/deployment/docker-man/my-*.xml \
  /boot/config/plugins/dockerMan/templates-user/
cp /tmp/mergeron-install/deployment/docker-man/prepare-networks.sh \
  /mnt/user/appdata/mergeron/prepare-networks.sh
cp /tmp/mergeron-install/deployment/docker-man/reconcile-networks.sh \
  /mnt/user/appdata/mergeron/reconcile-networks.sh
chmod 700 /mnt/user/appdata/mergeron/prepare-networks.sh \
  /mnt/user/appdata/mergeron/reconcile-networks.sh
```

Les valeurs proposées par les formulaires utilisent `/mnt/user/appdata`. Si votre
stockage utilise un autre emplacement, modifier les chemins dans chaque formulaire avant
de cliquer sur **Apply**, ainsi que le chemin du profil `seccomp=` dans
**Extra Parameters** du formulaire `mergeron`.

Dans le formulaire `mergeron-ui`, remplacer **URL publique Mergeron** par le
domaine HTTPS réellement utilisé (par exemple
`https://mergeron.example.com`). Cette valeur doit correspondre à l’adresse
WebUI du proxy inverse : elle alimente les callbacks OAuth MCP et les URL
OnlyOffice. Une ancienne adresse redirigerait encore les connexions MCP vers
l’ancien domaine. Si **Administration > OnlyOffice > URL publique Mergeron**
contient une valeur personnalisée, celle-ci reste prioritaire et doit être mise
à jour elle aussi.

## 2. Préparer les données et les secrets

Si l'installation Compose existe déjà, conserver le dossier `state` actuel et
passer directement à la section suivante.

Pour une nouvelle installation :

```bash
STATE=/mnt/user/appdata/mergeron/state
mkdir -p "$STATE"/{home,workspace,logs,ssh,manager-run,manager-state}
openssl rand -hex 48 > "$STATE/backend-token.txt"
cp "$STATE/backend-token.txt" "$STATE/backend-token-nginx.txt"
install -m 440 /dev/null "$STATE/openai-api-key.txt"
editor "$STATE/openai-api-key.txt"
chown -R 11002:11002 "$STATE/home" "$STATE/workspace" "$STATE/logs" "$STATE/ssh"
chmod 700 "$STATE/ssh"
chmod 400 "$STATE/backend-token.txt" "$STATE/backend-token-nginx.txt"
chmod 440 "$STATE/openai-api-key.txt"
```

Les deux fichiers `backend-token*.txt` doivent contenir exactement la même
valeur. Aucun secret ni contenu de `state` ne doit être ajouté à Git.

## 3. Préparer les réseaux

Le proxy choisi (et Authentik dans le mode historique) doit appartenir au réseau
externe choisi. Le nom par défaut est `mergeron-proxy`. Exporter
`MERGERON_PROXY_NETWORK` avant de lancer **les deux scripts** si son nom diffère.
Conserver aussi cette variable dans le script de démarrage du réconciliateur.
Exécuter
ensuite le script idempotent :

```bash
/mnt/user/appdata/mergeron/prepare-networks.sh
```

Il crée ou vérifie :

- `mergeron-isolated`, réseau interne sans accès Internet direct ;
- `mergeron-external`, réseau de sortie de Squid ;
- `mergeron-admin`, réseau administratif `172.30.44.0/28` ;
- `mergeron-proxy`, réseau partagé existant de Traefik et Authentik.

Le script s'arrête sans modifier un réseau existant si sa configuration ne
correspond pas à celle attendue.

Lancer ensuite le réconciliateur depuis l'Appdata :

```bash
nohup /mnt/user/appdata/mergeron/reconcile-networks.sh watch \
  >> /var/log/mergeron-network-reconciler.log 2>&1 &
```

Il contrôle périodiquement la topologie Docker. Après chaque création ou mise à
jour DockerMan, il rattache automatiquement les réseaux secondaires suivants :

- `mergeron-ui` à `mergeron-admin` ;
- `mergeron-ingress` à `mergeron-proxy` ;
- `mergeron-squid` à `mergeron-external`.

Il vérifie également les alias DNS sur chaque réseau déjà raccordé. Si
DockerMan a conservé le réseau mais perdu ses alias lors d'un renommage ou
d'une recréation, le réconciliateur rétablit `mergeron-ui`,
`mergeron-ingress` et `mergeron-squid`. Le nom historique `mergeron` de
l’application principale reste reconnu pendant la transition vers
`mergeron-ui`.

Les trois conteneurs démarrent volontairement sur `mergeron-isolated`. Cette
méthode est nécessaire car Docker n'accepte qu'un réseau de démarrage dans la
commande créée par DockerMan. Une connexion ajoutée manuellement avec
`docker network connect` disparaîtrait à la prochaine recréation du conteneur.

Pour rendre cette surveillance persistante, créer dans le plugin **User
Scripts** un script nommé `Mergeron network reconciler`, contenant :

```bash
#!/bin/bash
nohup /mnt/user/appdata/mergeron/reconcile-networks.sh watch \
  >/var/log/mergeron-network-reconciler.log 2>&1 &
```

Choisir la planification **At Startup of Array**. Le fichier PID empêche le
lancement de plusieurs surveillances identiques. Après un redémarrage, vérifier
le journal `/var/log/mergeron-network-reconciler.log` avant une mise à jour
DockerMan. Cette procédure ajoute uniquement une entrée User Scripts à la clé
USB ; elle ne modifie pas les données applicatives.

## 4. Migrer depuis Compose Manager

Ne pas exécuter simultanément les versions Compose et DockerMan : elles portent
les mêmes noms de conteneurs et utilisent les mêmes données.

1. sauvegarder `/mnt/user/appdata/mergeron/state/home` ;
2. désactiver l'autostart de l'ancienne stack dans Compose Manager ;
3. arrêter la stack ;
4. supprimer uniquement les trois anciens conteneurs, sans supprimer `state` ;
5. exécuter `prepare-networks.sh` ;
6. créer les trois conteneurs avec les formulaires ci-dessous.

Les volumes persistants ne sont pas supprimés quand un conteneur est retiré.
Éviter néanmoins toute action visant le dossier Appdata.

## 5. Ajouter les conteneurs

Dans **Docker**, cliquer sur **Add Container**, puis sélectionner successivement
les modèles dans **Template** :

1. `mergeron-squid` ;
2. `mergeron` ;
3. `mergeron-ingress` ;
4. `mergeron-manager`.

Activer **Advanced View**, vérifier les chemins proposés, puis cliquer sur
**Apply** pour chacun. Aucun port et aucune option `--network` ne doivent être
ajoutés manuellement dans **Extra Parameters**. Le réconciliateur ajoute les
réseaux secondaires dès que DockerMan recrée un conteneur Codex.

Le formulaire `mergeron-manager` monte le socket Docker en lecture seule et le
dossier `state/manager-run`, également monté dans `mergeron-ui`. Il n'expose
aucun port, n'appartient à aucun réseau et reste en observation uniquement.

Dans les options d'autostart d'Unraid, conserver le même ordre. Un délai court
entre les conteneurs est acceptable, mais les contrôles de santé restent la
référence pour vérifier qu'ils sont prêts.

Adapter enfin l'adresse **WebUI** du formulaire `mergeron` à l'URL publique
réelle, par exemple `https://mergeron.example.com`.

## 6. Vérifier le déploiement

```bash
docker inspect mergeron-squid --format '{{.State.Health.Status}}'
docker inspect mergeron --format '{{.State.Health.Status}}'
docker inspect mergeron-ingress --format '{{.State.Health.Status}}'
docker inspect mergeron-manager --format '{{.State.Health.Status}}'
docker network inspect mergeron-isolated
/mnt/user/appdata/mergeron/reconcile-networks.sh once
curl -I https://mergeron.example.com
```

Le backend `mergeron` ne doit avoir aucun port publié. Traefik doit joindre
uniquement `mergeron-ingress:8080` sur `mergeron-proxy`.

## 7. Mettre à jour et revenir en arrière

Le formulaire principal utilise
`ghcr.io/maxhugit/mergeron:latest`. Dans l'onglet **Docker** :

1. lancer **Check for Updates** ;
2. choisir **Update** sur `mergeron` ;
3. attendre que son état redevienne `healthy` ;
4. tester la connexion, une conversation et les intégrations.

Cette opération télécharge l'image et recrée seulement le conteneur ; les
données restent dans `/mnt/user/appdata/mergeron/state`.

Après la recréation, vérifier que le réconciliateur a remis `mergeron` sur
`mergeron-admin`. Une mise à jour réussie de l’image ne garantit pas à elle seule
que les réseaux secondaires sont présents.

Pour un retour arrière, remplacer temporairement `latest` dans le champ
**Repository** par le tag immuable `sha-<commit>` précédemment validé, puis
cliquer sur **Apply**.

Les formulaires Ingress et Squid utilisent respectivement `nginx:stable` et
`ubuntu/squid:latest`. Unraid peut ainsi signaler leurs nouvelles versions avec
**Check for Updates**. Une mise à jour reste manuelle : vérifier les mises à
jour proposées, lancer **Update**, puis contrôler que les trois conteneurs sont
de nouveau `healthy` et que l'interface publique répond correctement.

Le réconciliateur est installé dans
`/mnt/user/appdata/mergeron/reconcile-networks.sh`. Son journal est disponible
dans `/var/log/mergeron-network-reconciler.log`. L'entrée User Scripts est
enregistrée sur la clé USB par Unraid afin de survivre au redémarrage.

## 8. Source de vérité et maintenance

Les modèles XML copiés dans `/boot/config/plugins/dockerMan/templates-user/`
permettent de recréer les formulaires. Les fichiers réellement persistants de
l’application restent dans `/mnt/user/appdata/mergeron`.

Lorsqu’une nouvelle version du dépôt modifie un modèle XML ou un fichier sous
`deployment/config/`, comparer puis recopier le fichier concerné avant de
réappliquer le formulaire. Une mise à jour d’image ne remplace pas les fichiers
de configuration montés depuis l’Appdata.

Conserver ensemble dans la sauvegarde :

- `state/home`, `state/workspace` et `state/ssh` ;
- les fichiers de `config/` ;
- les deux scripts réseau ;
- les modèles DockerMan présents sur la clé USB, si l’on veut retrouver les
  formulaires personnalisés exactement à l’identique.
