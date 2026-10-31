# Installer Mergeron

**Mergeron Manager est le seul parcours d’installation pris en charge.**
Vous installez le Manager ; il prépare les données, les secrets internes, les
réseaux et les trois conteneurs Mergeron. Ne créez pas ces dépendances à la main
et ne lancez pas `deployment/compose.yml` pour installer une deuxième pile.

## 1. Préparer l’hôte

Il faut un hôte **Docker Linux amd64**, un dossier persistant, une sauvegarde
externe, un domaine et un proxy HTTPS de votre choix. Le noyau doit autoriser
le bac à sable non privilégié de Mergeron ; Docker Desktop n’est pas une
validation de production. L’application créée est limitée à 8 Gio et 3,5 CPU :
prévoir les ressources nécessaires aux projets et la place pour les images.

Ni NAS particulier, ni fournisseur SSO, ni service externe n’est nécessaire.
Le compte local est le mode standard. Le SSO est facultatif.

Les commandes suivantes s’exécutent avec les droits d’administration Docker,
sur **l’hôte Docker**. Les chemins `/srv/mergeron` sont des exemples à adapter.

```sh
mkdir -p /srv/mergeron/state/manager-run /srv/mergeron/state/manager-state
chown 0:11002 /srv/mergeron/state/manager-run
chmod 750 /srv/mergeron/state/manager-run
chmod 700 /srv/mergeron/state/manager-state
```

Créer le réseau ci-dessous **seulement s’il n’existe pas déjà**, puis raccorder
durablement votre proxy à ce même réseau dans sa propre configuration :

```sh
docker network create mergeron-proxy
```

Le Manager ne configure ni ce réseau externe, ni DNS, ni certificat, ni proxy
HTTPS. Voir le [raccordement réseau](installation-portable.md).

Le modèle du proxy sortant permet la lecture des métadonnées des images auprès
de GHCR et des deux hôtes publics Docker Hub `auth.docker.io` et
`registry-1.docker.io`. Une configuration Squid persistante n’est pas remplacée
à la mise à jour : l’opérateur ajoute ces deux hôtes exacts, valide la
configuration et recharge le proxy pour la comparaison de plateforme NGINX/Squid.
Garder les refus des réseaux privés et le contrôle TLS ; voir les
[mises à jour des conteneurs](container-updates.md).

## 2. Choisir les paramètres

Copier [manager.env.example](../deployment/manager.env.example) dans
`/srv/mergeron/manager.env`, **hors Git**, et le modifier :

| Variable                   | À renseigner                                              |
| -------------------------- | --------------------------------------------------------- |
| `MERGERON_STATE_ROOT`      | Racine persistante sur l’hôte : `/srv/mergeron/state`.    |
| `MERGERON_WEBUI_URL`       | Votre adresse HTTPS réelle.                               |
| `MERGERON_PROXY_NETWORK`   | Nom exact du réseau partagé avec votre proxy.             |
| `MERGERON_ADMIN_SUBNET`    | Sous-réseau privé libre sur cet hôte, sans chevauchement. |
| `MERGERON_INSTALL_ENABLED` | Mettre `true` pour autoriser la première installation.    |

L’exemple utilise le canal `edge`, correspondant au code décrit dans ces guides.
Pour la production, choisir une version publiée et validée du **Manager et de
l’application** ; un ancien `latest` ne possède pas forcément les nouveautés de
`main`. Le tag du Manager se choisit dans la commande ci-dessous, celui de
l’application dans `MERGERON_APP_IMAGE`. Voir les [versions](publications.md).

La [référence des variables](variables-manager.md) explique chaque défaut et
chaque option. Aucun mot de passe administrateur, secret SSO ou jeton d’agent
n’est à saisir dans cet exemple.

## 3. Démarrer uniquement le Manager

Adapter les trois chemins de montage **et** `MERGERON_STATE_ROOT` ensemble :
`/host-state` doit désigner exactement cette racine hôte.

```sh
docker run -d --name mergeron-manager --restart unless-stopped \
  --network none --read-only --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_READ_SEARCH \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=8m \
  --pids-limit 64 --memory 512m --cpus 0.25 \
  --log-opt max-size=10m --log-opt max-file=3 \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  --mount type=bind,src=/srv/mergeron/state,dst=/host-state \
  --mount type=bind,src=/srv/mergeron/state/manager-run,dst=/run/mergeron-manager \
  --mount type=bind,src=/srv/mergeron/state/manager-state,dst=/var/lib/mergeron-manager \
  --env-file /srv/mergeron/manager.env \
  ghcr.io/maxhugit/mergeron-manager:edge
```

Le Manager n’a ni page Web ni port à ouvrir. Il utilise Docker localement et un
socket Unix pour communiquer avec Mergeron. Le montage `readonly` du socket
Docker **ne retire pas** ses droits de pilotage : ne jamais l’exposer aux agents
ou au réseau. Conserver le contrôle de santé fourni par l’image.

```sh
docker ps -a --filter name=mergeron
docker logs --tail 100 mergeron-manager
```

Attendre que `mergeron-manager`, `mergeron-ui`, `mergeron-ingress` et
`mergeron-squid` soient démarrés et sains. Un Manager sain ne prouve pas, à lui
seul, que l’installation applicative a réussi. En cas de blocage, suivre le
[dépannage](exploitation-depannage.md), sans supprimer les données pour forcer
le passage.

## 4. Créer le premier administrateur

Les nouvelles installations disposent d’un **assistant Web de première
configuration**. Aucun fichier de coordonnées ou de mot de passe n’est à préparer.
Utiliser un Manager et une application qui incluent tous deux ce parcours ; mettre
à jour seulement l’application d’une ancienne installation ne l’active pas.

Configurer d’abord le proxy HTTPS vers `mergeron-ingress:8080`, puis ouvrir
l’adresse déclarée dans `MERGERON_WEBUI_URL`. La page « Configurer votre plateforme »
demande de prouver l’accès au serveur avec la commande suivante, exécutée sur
l’hôte Docker, pas dans une conversation d’agent :

```sh
docker exec -it mergeron-ui node /app/scripts/setup-admin.cjs
```

Adapter le nom du conteneur si la pile utilise un autre préfixe. La commande
affiche seulement dans cette console un code aléatoire valable **15 minutes**.
Coller ce code dans la page, puis renseigner prénom, nom, e-mail, identifiant et
mot de passe avec confirmation. Le mot de passe exige au moins 12 caractères ;
l’identifiant accepte de 3 à 64 lettres, chiffres, points, tirets et tirets bas.
Aucun service e-mail ni SSO n’est nécessaire pour ce premier compte local.

Après validation, le compte administrateur est créé et l’assistant est fermé.
Se connecter normalement avec ce compte ; les comptes suivants se gèrent dans
**Paramètres → Personnes**. Un premier visiteur sans code ne peut pas s’inscrire.

Le code ne doit figurer ni dans une URL, ni dans un ticket ou un journal. La
commande ne l’enregistre pas dans les journaux de l’application. La relancer
invalide les codes et sessions d’initialisation précédents. Après dix codes
incorrects, attendre une minute ou générer un nouveau code depuis la console.

L’assistant n’est jamais activé sur simple absence d’administrateur : une
installation existante, une restauration ou un compte désactivé ne le rouvrent
pas. Une erreur de base ou d’autorisation ne donne pas accès. La suppression du
fichier d’autorisation interne ne constitue pas une méthode de récupération.
Si une interruption ferme l’assistant **sans avoir créé aucun compte ni projet**,
la reprise volontaire depuis l’hôte est :

```sh
docker exec -it mergeron-ui node /app/scripts/setup-admin.cjs --retry-interrupted
```

Cette option refuse une installation déjà initialisée ou contenant des personnes
ou projets. Pour les comptes d’une installation existante, conserver la procédure
de [récupération administrateur](configuration-integrations.md#initialisation-et-récupération-administrateur),
qui utilise l’outil privilégié `scripts/provision-person.cjs`, sans réouvrir
l’inscription publique. Les [contrats techniques](initial-admin-setup.md) détaillent
les contrôles, le stockage et les limites de restauration.

## 5. Ouvrir et vérifier Mergeron

Configurer votre proxy HTTPS pour transmettre le domaine vers
**`mergeron-ingress:8080`**, sur le réseau choisi. Ne publier ni le backend 8172,
ni le port des aperçus 8173, ni le filtre sortant 3128 sur l’hôte.

1. Se connecter à l’adresse configurée avec le compte créé.
2. Dans **Paramètres → Codex → Codex CLI**, installer le CLI validé fourni par
   le Manager, puis configurer l’accès au moteur avant de lancer un agent.
3. Créer un projet de test, vérifier une conversation et son explorateur.
4. En fenêtre privée, vérifier qu’une personne non connectée n’accède pas aux données.
5. Vérifier les composants gérés et leur santé dans les paramètres du serveur.

Le [CLI géré](operations/managed-codex-runtime.md), les [aperçus de projets](previsualisations-agents.md)
et le [navigateur distant](navigateur-annote.md) ont leurs pages dédiées ; ces
deux derniers services ne sont pas nécessaires à la première connexion.

Après validation, remettre `MERGERON_INSTALL_ENABLED=false` dans le fichier
privé puis recréer **uniquement le Manager** avec les mêmes paramètres et
montages. Modifier le fichier sans recréer le conteneur ne change pas ses
variables actives. Ne pas retirer les dépendances ni les données.

Les mises à jour applicatives se font ensuite depuis Mergeron, avec plan et
confirmation. Le remplacement du Manager reste une opération sur l’hôte.
Conserver cette définition et une [sauvegarde externe](sauvegarde-restauration.md).
