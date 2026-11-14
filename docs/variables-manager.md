# Variables de Mergeron Manager

Ces paramètres vont sur le **conteneur Manager**, dans le fichier privé
`manager.env` du [guide](installation.md), ou dans votre outil d’administration.
Recréer le Manager applique leur nouvelle valeur ; cela ne réécrit pas les
conteneurs et fichiers déjà présents. Les défauts ci-dessous sont ceux du
**code**, pas d’un formulaire hôte. Une valeur explicite reste prioritaire.

## Paramètres courants

| Variable                     | Défaut du code                                                                         | Fonction et utilisation                                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERGERON_INSTALL_ENABLED`   | `false`                                                                                | `true` autorise la création des ressources manquantes au démarrage. Activer pour l’installation neuve, puis désactiver après validation. Aucun écrasement d’une ressource incompatible.                                                                                                                               |
| `MERGERON_STACK_PREFIX`      | `mergeron`                                                                             | Préfixe des conteneurs et réseaux, par exemple `mergeron-ui`. Chaque instance doit avoir son préfixe ; ne pas changer celui d’une pile installée pour la renommer.                                                                                                                                                    |
| `MERGERON_STACK_ENVIRONMENT` | `production`                                                                           | `production` ou `development`. Définit l’identité visuelle et certains défauts, pas le canal d’image. `development` exige un préfixe distinct de `mergeron`.                                                                                                                                                          |
| `MERGERON_STATE_ROOT`        | `/srv/<préfixe>/state`                                                                 | Racine persistante **sur l’hôte Docker**, à monter exactement sur `/host-state`. Ses sous-dossiers `manager-run` et `manager-state` ont aussi leurs montages. Ne pas changer ce chemin sans restauration/déplacement contrôlé.                                                                                        |
| `MERGERON_APPDATA_ROOT`      | `<racine>/appdata`                                                                     | Dossier hôte exposé à l’application sous `/appdata`. Limiter aux fichiers nécessaires, jamais `/` ni tous les secrets de l’hôte. Si le dossier existe déjà, vérifier ses droits pour `11002:11002`. Ce montage externe n’est pas inclus dans les sauvegardes de mise à jour.                                          |
| `MERGERON_WEBUI_URL`         | `https://mergeron.example.com`, ou `https://mergeron-dev.example.com` en développement | Votre vraie URL HTTPS canonique, transmise à l’application pour ses liens et rappels. Ne configure ni DNS, ni certificat, ni proxy et ne sélectionne pas la pile gérée.                                                                                                                                               |
| `MERGERON_PROXY_NETWORK`     | `mergeron-proxy`                                                                       | Réseau externe **déjà créé**, partagé entre le proxy HTTPS et l’ingress. Pas le réseau `host`, `none` ou un réseau privé de la pile.                                                                                                                                                                                  |
| `MERGERON_ADMIN_SUBNET`      | `172.30.44.0/28`, ou `172.30.44.16/28` en développement                                | CIDR IPv4 privé du réseau administratif. Choisir une plage libre sans chevauchement. Préfixes acceptés `/8` à `/30` ; `/28` suffit au parcours courant.                                                                                                                                                               |
| `MERGERON_AUTH_MODE`         | `native`                                                                               | Garder `native` : comptes locaux et SSO OIDC facultatif gérés par Mergeron. Ce n’est pas un sélecteur de fournisseur SSO. La valeur technique `authentik` désigne un adaptateur de proxy spécifique, pas un prérequis. Sélectionne le modèle ingress **à sa création seulement**, sans remplacer un fichier existant. |

Le [raccordement réseau et SSO](installation-portable.md) reste indépendant des
produits choisis. Le Manager et le socket Docker ne sont jamais publiés sur le réseau.

Lors d’une installation neuve, le Manager prépare automatiquement l’autorisation
privée de l’[assistant du premier administrateur](initial-admin-setup.md).
`MERGERON_WEBUI_URL` doit être HTTPS ; son origine exacte est imposée à la
validation du code et du formulaire. Aucun mot de passe ni code n’est à placer
dans une variable d’environnement. Une mise à jour ou une adoption ne réarme
pas cet assistant. Le préfixe de pile est aussi transmis à l’application pour
afficher la bonne commande de console, sans publier le Manager sur le réseau.

## Images et présentation dans l’hôte

| Variable                    | Défaut du code                                                  | Fonction et utilisation                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MERGERON_APP_IMAGE`        | `ghcr.io/maxhugit/mergeron:latest`, ou `:edge` en développement | Image applicative à créer. Choisir une version publiée compatible avec le Manager ; un digest ou un tag `sha-…` fixe une révision. Modifier cette variable n’effectue pas une mise à jour d’un conteneur existant. |
| `MERGERON_INGRESS_IMAGE`    | `nginx:stable`                                                  | Image de la passerelle entrante fournie dans Mergeron. Ne pas remplacer son logiciel ou son dépôt arbitrairement.                                                                                                  |
| `MERGERON_EGRESS_IMAGE`     | `ubuntu/squid:latest`                                           | Image du filtre sortant fourni dans Mergeron. Seules les références des dépôts autorisés sont acceptées.                                                                                                           |
| `MERGERON_HOST_INTEGRATION` | `none`                                                          | Garder `none` pour un hôte générique. `unraid` ajoute uniquement ses métadonnées d’affichage : icône, lien et terminal. Aucun changement des données, réseaux ou de l’authentification.                            |
| `MERGERON_ICON_URL`         | Icône Mergeron adaptée à l’environnement                        | URL personnalisée facultative pour les métadonnées hôtes. Vide : choix automatique. Ne change pas l’environnement de la pile.                                                                                      |

L’image du **Manager** se choisit dans `docker run` ou le formulaire hôte, pas
dans une variable. Les mises à jour des dépendances passent ensuite par le
[plan et la confirmation dans Mergeron](container-updates.md).

La comparaison des images ne nécessite pas de nouvelle variable ni de réseau
Manager : il conserve `--network none`. Le backend utilise le proxy sortant
existant. Une ancienne configuration Squid doit autoriser précisément
`auth.docker.io` et `registry-1.docker.io` pour les manifestes NGINX/Squid ; aucune
réécriture automatique de ce fichier persistant n’est effectuée.

## Services facultatifs

| Variable                           | Défaut du code                                                                                                | Fonction et utilisation                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MERGERON_MANAGE_BROWSER`          | `false`                                                                                                       | Compatibilité historique. Après migration, le choix persistant dans [Serveur → Compétences](server-capabilities.md) pilote le navigateur. Les compagnons conformes existants sont conservés ; cette variable ne crée aucun conteneur. Voir le [service dédié](navigateur-annote.md).  |
| `MERGERON_PREVIEWS_ENABLED`        | `false`                                                                                                       | Active l’orchestration des environnements de test. Les autorisations projet restent nécessaires. Transmis à une **nouvelle** application ; ne modifie pas un conteneur déjà présent.                                                                                                  |
| `MERGERON_PREVIEW_DOMAIN`          | `preview.invalid` pour l’installateur                                                                         | Domaine réservé aux aperçus, par exemple `preview.example.com`, sans protocole ni `*.`. À définir explicitement : le runtime d’aperçu n’utilise pas ce défaut comme configuration complète. DNS wildcard, certificat et routage restent à préparer.                                   |
| `MERGERON_PREVIEW_IMAGES`          | `{}`                                                                                                          | Objet JSON de 16 runtimes autorisés au maximum. Chaque entrée exige une `image` épinglée par digest, déjà disponible sur l’hôte. `description`, `user` et `tmpfs` sont facultatifs. Voir le [format complet](previsualisations-agents.md#activer-le-service-et-autoriser-les-images). |
| `MERGERON_PREVIEW_ALLOWED_DOMAINS` | `registry.npmjs.org,pypi.org,files.pythonhosted.org,github.com,codeload.github.com,raw.githubusercontent.com` | Domaines Internet autorisés aux runtimes, séparés par des virgules. Adapter aux dépendances sans ouvrir les réseaux privés. Distinct du filtre de l’application et du navigateur.                                                                                                     |

Le DNS du navigateur géré fait partie de son contrat de sécurité ; aucune
variable Manager ne permet de le remplacer librement.

## Paramètres internes : garder les valeurs livrées

Les chemins ci-dessous sont **internes au conteneur**, contrairement aux racines
hôtes. Une modification exige d’adapter les montages et le client applicatif ensemble.

| Variable                          | Défaut                                    | Fonction                                                                                                                    |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MERGERON_MANAGER_SOCKET`         | `/run/mergeron-manager/manager.sock`      | Socket Unix partagé avec l’application, pas un port HTTP.                                                                   |
| `MERGERON_MANAGER_SOCKET_GID`     | `11002`                                   | Groupe autorisé à utiliser le socket, créé en `0660` ; doit correspondre à l’application.                                   |
| `MERGERON_MANAGER_POLL_MS`        | `20000`                                   | Intervalle d’inventaire en millisecondes, minimum appliqué `5000`. Pas le rafraîchissement des conversations.               |
| `MERGERON_DOCKER_SOCKET`          | `/var/run/docker.sock`                    | API Docker locale, montée uniquement dans le Manager.                                                                       |
| `MERGERON_MANAGER_ADOPTION_PATH`  | `/var/lib/mergeron-manager/adoption.json` | Empreinte persistante de la pile adoptée ; journaux de mise à jour rangés à côté. Ne pas l’effacer pour masquer une dérive. |
| `MERGERON_MANAGER_HOST_STATE`     | `/host-state`                             | Montage interne correspondant exactement à `MERGERON_STATE_ROOT` sur l’hôte.                                                |
| `MERGERON_MANAGER_DEFAULT_CONFIG` | `/opt/mergeron-manager/default-config`    | Modèles livrés dans l’image, utilisés seulement pour créer les fichiers manquants. Pas un réglage utilisateur courant.      |

Les variables des helpers `MERGERON_PREVIEW_TARGET`, `MERGERON_PREVIEW_PUBLIC_HOST`,
`MERGERON_PREVIEW_RUN_ID`, `MERGERON_PREVIEW_HEALTH_PATH` et
`MERGERON_PREVIEW_TRANSPORT_TOKEN` ne sont pas des options d’installation : ne
pas les saisir manuellement ni extraire leurs jetons. `HOSTNAME` est fourni par Docker.

## Réglages après installation

Les comptes, l’accès au moteur d’agents, le SSO OIDC, le chat et les connexions
des projets se configurent séparément dans Mergeron. Les choix de sauvegarde
avant mise à jour et la rétention se règlent dans l’interface, pas dans de
nouvelles variables Manager.

Pour une autre instance de développement, utiliser à la fois un autre préfixe,
un autre dossier persistant, un autre domaine et un autre sous-réseau. Ne jamais
tester une deuxième pile sur les données de production.

## Catalogue quotidien temporaire

`MERGERON_APP_CATALOG_BYPARR_ENABLED` vaut `false` par défaut. `true` permet au Manager de préparer et gérer le conteneur Byparr dédié quand un administrateur active le cache quotidien dans les paramètres Codex. Aucun port n’est publié et aucune donnée de Mergeron n’est montée dans ce conteneur. Voir [le cache et son journal](application-catalog-cache.md) pour l’activation et le retrait de ce contournement.

## Transcription locale facultative

| Variable                              | Défaut                                                                         | Fonction                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MERGERON_TRANSCRIPTION_ENABLED`      | `false`                                                                        | Autorise la création à la demande du worker CPU de fichiers audio/vidéo.                                                                                                                                                             |
| `MERGERON_TRANSCRIPTION_DIARIZATION`  | `bundled`                                                                      | `bundled` utilise les modèles inclus dans l’image, sans compte ni copie manuelle. `false` désactive la diarisation. `custom` monte `config/transcription-diarization` en lecture seule ; `true` conserve ce comportement historique. |
| `MERGERON_TRANSCRIPTION_IDLE_SECONDS` | `300`                                                                          | Délai sans bail avant arrêt ; entier de 30 à 86 400 secondes.                                                                                                                                                                        |
| `MERGERON_TRANSCRIPTION_IMAGE`        | `ghcr.io/maxhugit/mergeron-transcription:edge` en Dev, `:latest` en production | Uniquement ce dépôt, avec tag explicite ou digest SHA-256. Pas de registre arbitraire.                                                                                                                                               |

Voir [le fonctionnement, les ressources et les modèles](file-transcription.md).

### Cycle de vie du navigateur géré

Avec `MERGERON_MANAGE_BROWSER=true`, le navigateur conforme existant démarre à la demande.
Le Manager ne le réveille pas pour lire son inventaire ou détecter une mise à jour.

| Variable                           | Défaut | Rôle                                                                                                    |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `MERGERON_BROWSER_IDLE_SECONDS`    | `300`  | Délai de 30 à 86 400 secondes après libération de toutes les réservations avant l’arrêt.                |
| `MERGERON_BROWSER_STARTUP_SECONDS` | `90`   | Attente maximale de 10 à 300 secondes du contrôle de santé. Un dépassement est signalé à l’utilisateur. |

Ces réglages appartiennent à la définition persistante du Manager (Compose ou formulaire hôte).
Ils s’appliquent à toutes les conversations de la pile. Les nouvelles installations ne démarrent
pas automatiquement un navigateur arrêté. Après redémarrage du Manager, un délai d’inactivité
complet laisse aux sessions de l’application le temps de renouveler leurs réservations.

Le backend peut explicitement utiliser `MERGERON_BROWSER_LIFECYCLE=external` pour un runtime
externe non géré. Les anciens Managers sans cette API conservent le raccordement direct ; une
erreur réseau du Manager moderne reste une erreur, sans démarrage alternatif ni modification du sandbox.

## Suivi HTTP indépendant

`MERGERON_UPDATE_MONITOR_ENABLED` vaut `false` par défaut. Activer `true` seulement après installation et vérification des deux relais HTTP indépendants et de leur routage TLS ; voir [le suivi des mises à jour](continuous-updates.md). Cette activation fait établir une session de suivi avant les mises à jour.

Les relais utilisent uniquement `MERGERON_PUBLIC_HOST` (nom public exact), `MERGERON_GATEWAY_UPSTREAM` (ingress interne fixe) et `MERGERON_MONITOR_DIRECTORY` (`/monitor`, projection publique montée en lecture seule). Ces trois variables ne vont pas sur le conteneur applicatif.

Le runtime de preview reçoit aussi `MERGERON_PREVIEW_RECEIPT_PATH`, chemin réservé
vers l’entrée de génération écrite après synchronisation. Cette variable est
créée par le Manager, non configurable par la recette et sans secret. Le
[contrat de vérification de génération](environnement-test.md#contrat-de-marqueurs-applicatifs)
décrit son utilisation et ses limites ; elle ne modifie aucun volume ni réseau.

## Sortie réseau des journaux GitHub Actions

Aucune nouvelle variable ni clé transmise aux agents n’est requise. La connexion
GitHub du projet conserve son jeton et doit disposer d’**Actions: read** pour les
lectures privées. Le modèle Squid fourni par le Manager permet les hôtes
`productionresultssa<N>.blob.core.windows.net` des liens signés de journaux, sans
ouvrir tout Azure Blob. Une configuration persistante personnalisée est conservée ;
reporter la règle dédiée selon les [prérequis d’installation](installation.md).
Les refus privés, TLS, les restrictions de conteneur et le proxy des aperçus
restent indépendants et inchangés.
