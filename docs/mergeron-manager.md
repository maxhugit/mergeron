# Mergeron Manager

Mergeron Manager est le futur gestionnaire local de la pile Docker Mergeron. Il
doit à terme installer, mettre à jour, surveiller et réparer les trois
conteneurs de la plateforme. Son déploiement est séparé de l'application afin
qu'une panne ou une mise à jour de `mergeron-ui` ne supprime jamais le composant
chargé de l'observer.

## Installation initiale sécurisée

Le Manager sait désormais préparer une installation neuve et continue
d'inventorier les installations existantes. Il :

- inventorie `mergeron-ui`, `mergeron-ingress` et `mergeron-squid` avec l'API
  Docker locale ;
- reconnaît aussi les anciens noms `mergeron`, `codex-webui`,
  `codex-web-ingress` et `codex-web-squid` ;
- contrôle l'état, la santé, l'image et les réseaux de chaque conteneur ;
- vérifie que `/home/codex` et `/workspaces` restent montés depuis un stockage
  persistant ;
- expose son résultat à l'application par un socket Unix local ;
- produit un plan signé avant toute installation ;
- crée uniquement les dossiers, fichiers, réseaux et conteneurs manquants
  déclarés par le manifeste ;
- conserve l'adoption explicite d'une installation existante.

Le plan d'installation expose toujours une liste `destructiveActions` vide. L'installateur ne
supprime, ne renomme, ne recrée et n'écrase aucun conteneur, réseau, volume,
dossier ou fichier existant. Une ressource incompatible bloque toute
l'installation. Une interruption peut être reprise : le plan suivant ne
contient plus les ressources déjà créées et redémarre uniquement un conteneur
géré resté dans l'état `created` ou `stopped`.

L'image est publiée séparément sous
`ghcr.io/maxhugit/mergeron-manager`. Elle suit les mêmes tags `edge`,
`sha-<commit>`, `0.x.y`, `0.x` et `latest` que l'application, mais son cycle de
vie reste indépendant de `mergeron-ui`. Avant la première publication stable,
les formulaires utilisent `edge` ; `latest` n'est jamais inventé à partir d'une
construction non publiée.

## Barrières contre la perte de données

Le manifeste `manager/stack-manifest.json` décrit les composants acceptés, les
anciens noms, les réseaux attendus et les montages protégés. Le Manager bloque
toute future prise en charge si :

- plusieurs conteneurs correspondent au même composant ;
- le montage persistant de `/home/codex` est absent ou en lecture seule ;
- le montage persistant de `/workspaces` est absent ou en lecture seule.

Le chemin source réel de chaque montage est affiché dans les réglages généraux
du serveur. Les données ne sont jamais copiées vers un nouveau volume de
manière implicite. Les fichiers existants sont ouverts en lecture pour les
contrôles mais ne sont jamais réécrits.

## Isolation

Le Manager n'ouvre aucun port TCP. Il publie uniquement
`/run/mergeron-manager/manager.sock`, lisible par le groupe de l'application.
Le backend Mergeron relaie l'inventaire aux seuls administrateurs via
`GET /api/settings/manager/status`.

L'accès à `/var/run/docker.sock` donne techniquement des droits élevés sur
l'hôte. L'image du Manager reste donc minimale, sans accès Internet entrant et
sans outil client arbitraire. Son client Docker limite les écritures à la
création des réseaux et conteneurs du manifeste et au démarrage de ces derniers.
La mise à jour ajoute uniquement l'arrêt, le renommage et la suppression des
conteneurs vérifiés de la pile sélectionnée, sans suppression de volume, de
réseau ou de données persistantes. Aucune opération Docker arbitraire n'est
exposée par HTTP.

Le Manager conserve seulement `CHOWN` (création des dossiers applicatifs) et
`DAC_READ_SEARCH` (relecture des secrets privés appartenant à l'UID 11002).
Cette seconde capacité est indispensable à la reprise et à l'idempotence :
elle évite de rendre les secrets lisibles par tous, de changer leurs
propriétaires ou de les réécrire. Elle s'applique dans l'espace de montages du
Manager ; aucun montage de la racine de l'hôte n'est ajouté.

Les installations Compose et DockerMan montent le socket dans
`STATE_ROOT/manager-run`. Ce dossier ne contient aucune donnée métier. Le
Manager fonctionne sans réseau Docker (`network_mode: none`). `STATE_ROOT` est
également monté dans `/host-state` afin de créer les éléments manquants par des
ouvertures exclusives. L'enregistrement d'adoption reste séparé dans
`STATE_ROOT/manager-state/adoption.json`.

## Plan et application

`GET /v1/install/plan` retourne les créations prévues, les blocages, les
garanties de non-destruction et une empreinte SHA-256. `POST /v1/install`
demande cette empreinte et la confirmation exacte `INSTALL`; le Manager relit
Docker avant d'agir et refuse un plan devenu obsolète.

Pour une installation neuve sans interface, `MERGERON_INSTALL_ENABLED=true`
autorise l'application automatique du plan au démarrage. La valeur par défaut
reste `false`. Les fichiers de configuration nginx et Squid et les secrets
internes ne sont créés que s'ils sont absents. Si les deux copies du jeton
interne existent avec des valeurs différentes, l'installation est bloquée.

Le réseau externe choisi par `MERGERON_PROXY_NETWORK` (`mergeron-proxy` par
défaut) doit préexister. Pour une installation historique, renseigner son nom
actuel avant de mettre à jour le Manager (par exemple `net_standard`) ; il
n’est jamais renommé automatiquement. Le Manager crée uniquement
les trois réseaux appartenant à la pile : `isolated`, `external` et `admin`.
Les images absentes sont téléchargées explicitement dans le plan avant la
création des conteneurs.

Les valeurs génériques sont `/srv/<préfixe>/state` pour les données et son
sous-dossier `appdata` pour les dossiers accessibles aux agents.
`MERGERON_APPDATA_ROOT` choisit ce montage explicitement. Les alias historiques
restent isolés dans le module d’intégration ; voir les [adaptations](adapters/README.md).
Les métadonnées d’une interface hôte ne sont générées qu’avec son intégration
explicitement activée ; `MERGERON_HOST_INTEGRATION=none` est le défaut.
`MERGERON_AUTH_MODE=authentik|native` choisit le modèle ingress uniquement à sa
création. Voir [l’installation portable](installation-portable.md) pour les
prérequis d’authentification native et les proxys alternatifs.

## Adoption d'une installation existante

L'adoption ne modifie pas Docker. Après confirmation d'un administrateur, le
Manager enregistre exactement les identifiants des trois conteneurs, leurs
images, leurs réseaux et les sources des montages persistants. L'opération est
refusée si un composant est absent ou ambigu, si une image n'est pas autorisée,
si un réseau requis manque ou si `/home/codex` et `/workspaces` ne sont pas des
montages persistants accessibles en écriture.

L'interface transmet l'empreinte SHA-256 de l'aperçu affiché. Le Manager relit
Docker au moment de la confirmation et refuse l'adoption si cette empreinte a
changé. Le fichier est créé une seule fois avec des permissions `0600`. Une
différence ultérieure entre Docker et l'enregistrement passe l'installation en
état « dérive » et bloque toute future gestion automatique.

## Production et recette isolées

Le Manager de recette doit utiliser le dépôt
`ghcr.io/maxhugit/mergeron-manager:edge`, avec `MERGERON_APP_IMAGE` pointant
sur `ghcr.io/maxhugit/mergeron:edge`. Un tag `sha-…` reste volontairement
épinglé : « Forcer la mise à jour » retélécharge ce même tag, sans sélectionner
la dernière révision du canal. En production, conserver un tag stable choisi
explicitement plutôt que basculer sur `edge`.

Le contrôle de santé du Manager doit être hérité de l'image, en forme exec
(`CMD` avec `/nodejs/bin/node`). Ne pas ajouter `--health-cmd` aux paramètres
supplémentaires du XML : Docker le transforme en `CMD-SHELL`, alors que
l'image distroless ne contient pas `/bin/sh`. Cela marque à tort un Manager
fonctionnel comme défaillant après une recréation par l’outil hôte.

`MERGERON_STACK_ENVIRONMENT` déclare explicitement `production` ou
`development`. `MERGERON_STACK_PREFIX` sélectionne exclusivement les
conteneurs et réseaux à observer. Une recette utilise un préfixe dédié, par
exemple `mergeron-dev`, avec son propre `STATE_ROOT`, son propre sous-réseau
administratif et ses conteneurs préfixés. Le Manager refuse une pile
`development` qui réutilise le préfixe de production. Les anciens noms ne sont
reconnus que pour la pile `production` portant le préfixe canonique, afin qu'un
Manager de recette ne puisse jamais adopter un conteneur historique de
production.

Le domaine public ne participe jamais à la sélection des conteneurs. Il est
fourni séparément par `MERGERON_WEBUI_URL` dans le fichier d'environnement et
transmis à l'application sous `MERGERON_PUBLIC_URL`. Le dépôt ne contient donc
aucun domaine propre à une installation.

## Mise à jour transactionnelle et retour arrière

### Détection et confirmation dans l’interface

La carte de version constitue l’unique point d’entrée pour les mises à jour.
Elle vérifie automatiquement le canal `edge` (recette) ou `latest` (stable),
avec un cache de cinq minutes et un rafraîchissement manuel possible. La
détection lit les métadonnées OCI du registre GHCR, sans télécharger les
couches d’image ni modifier Docker. L’identité de l’image installée est
comparée à celle de la plateforme publiée, y compris à numéro de version
identique. Avec un ancien Manager, la comparaison utilise l’empreinte de
l’image déjà épinglée ou, à défaut, la révision embarquée. Mettre également
le Manager à jour permet la comparaison précise par identité d’image.

Les notes de version stables ou les commits GitHub entre les deux révisions
sont affichés avant confirmation. Les listes longues sont limitées à 100
commits avec un lien vers la comparaison complète. Une erreur de consultation
des descriptions ne masque pas une image détectée ; une erreur du registre
ne présente jamais l’installation comme étant à jour.

« Mettre à jour » vérifie les prérequis, puis ouvre une confirmation
« Installer et redémarrer ». La cible détectée est épinglée par digest dans
le plan afin qu’un déplacement ultérieur du tag ne change pas l’image
confirmée. La sélection manuelle reste accessible dans les options avancées.
Le bouton « Enregistrer les paramètres de fonctionnement » est indépendant
et n’apparaît que lorsque ces paramètres ont été modifiés.

Le proxy sortant doit autoriser `ghcr.io`, en plus de GitHub et des domaines
`githubusercontent.com` déjà utilisés. Le modèle Squid livré inclut cette
règle. Les installations existantes conservent volontairement leur configuration :
ajouter `acl allowed_domains dstdomain ghcr.io` avant de tester la détection
avec cette nouvelle version, puis recharger Squid. Aucun élargissement vers
les réseaux privés ou vers tous les domaines n’est nécessaire.

Les réglages généraux du serveur proposent un aperçu puis une confirmation de
mise à jour. L'opération continue dans le Manager lorsque l'application est
arrêtée ; son suivi reste disponible sur le socket local. Seuls les
administrateurs accèdent aux routes applicatives `/api/settings/manager/update`.

1. `POST /v1/update/plan` avec `images` sélectionne des images des seuls dépôts
   autorisés. Les trois services doivent être sains, gérés ou explicitement
   adoptés, avec des noms canoniques et des montages compatibles. Une dérive
   d'adoption bloque l'opération. L'ordre variable des montages Docker ne
   modifie pas l'empreinte.
2. `POST /v1/update` avec cette empreinte et
   `confirmation=UPDATE_WITH_ROLLBACK` lance l'opération en arrière-plan. Les
   images sont téléchargées avant l'arrêt et épinglées par empreinte publiée.
   Les spécifications Docker, réseaux et montages existants sont conservés.
3. Après arrêt des trois services, le Manager sauvegarde `home`, `workspace`,
   `logs`, `ssh`, `config` et les trois fichiers secrets sous
   `manager-state/updates/<opération>/backup`. L'espace libre doit permettre la
   sauvegarde et sa restauration. Les liens symboliques ne sont pas suivis ;
   les sockets temporaires sont ignorés, les autres fichiers spéciaux bloquent
   la sauvegarde. La copie conserve propriétaires, permissions ordinaires et
   dates, sans nécessiter de capacité supplémentaire.
4. Les anciens conteneurs sont conservés arrêtés sous un nom de secours. Les
   remplaçants démarrent dans l'ordre Squid, application, ingress. Chacun doit
   devenir sain dans un délai borné, puis les trois sont contrôlés ensemble.
5. Après validation durable du résultat, seuls les anciens conteneurs arrêtés
   sont supprimés (`force=false`, `v=false`). Les images et sauvegardes restent
   présentes. Le référentiel d'adoption est actualisé uniquement s'il existait
   déjà ; aucune adoption implicite n'est créée.

Une erreur avant validation déclenche la restauration des données et le
redémarrage des anciens conteneurs. Les données écrites par la version rejetée
sont déplacées dans `quarantine`, jamais supprimées. Le journal privé `0600`
conserve leur référence : les dossiers retenus restent en réalité sous des noms
cachés `.manager-quarantine-<opération>-<entrée>` dans `STATE_ROOT`, avec des
liens relatifs depuis `quarantine`. Les renommages restent dans le même dossier
parent pour conserver les permissions privées sans capacité supplémentaire.
Le journal
permet de reprendre la récupération au redémarrage du Manager, y compris si
Docker a créé un conteneur juste avant l'interruption. Après le point de
validation, le redémarrage termine seulement le nettoyage. Si la récupération
échoue, toute nouvelle installation ou mise à jour est bloquée ;
`POST /v1/update/recover` avec `confirmation=RETRY_RECOVERY` la réessaie.

`POST /v1/update/rollback`, avec l'identifiant de la dernière opération réussie
et `confirmation=ROLLBACK_WITH_DATA_RESTORE`, restaure aussi les données de sa
sauvegarde. Cela annule les modifications applicatives postérieures à cette
sauvegarde, conservées séparément en quarantaine. Les versions plus anciennes
ne sont pas sélectionnables implicitement. Les sauvegardes et journaux ne sont
pas purgés automatiquement : prévoir leur rétention et surveiller l'espace.

Le suivi public ne contient jamais les spécifications complètes, variables
d'environnement ni secrets du journal privé. L'installation, l'adoption, la
mise à jour et la récupération ne peuvent pas s'exécuter simultanément.

### Limites explicites

- Les fichiers externes montés sous `/appdata` ne sont ni sauvegardés ni
  restaurés ; ils ne sont jamais supprimés. Le rollback couvre les données
  applicatives sous `STATE_ROOT`, pas tous les fichiers de l'hôte.
- Les ACL et attributs étendus ne sont pas copiés. Un stockage utilisant ces
  mécanismes nécessite une sauvegarde externe adaptée avant mise à jour.
- Les volumes Docker et les noms historiques doivent être migrés explicitement
  avant cette première version de l'updater ; ils sont refusés, pas convertis.
- Le Manager ne se met pas lui-même à jour et ne répare pas encore une pile
  arbitrairement endommagée.

## Étape suivante

Réparation limitée aux conteneurs et réseaux déclarés dans le manifeste.

Les volumes ou dossiers persistants ne feront pas partie d'une suppression ou
d'un retour arrière automatique.
