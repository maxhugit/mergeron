# Mergeron Manager

Pour une installation neuve, suivre [Installer Mergeron](installation.md) puis
la [référence des variables](variables-manager.md). Cette page décrit les
opérations et garanties du Manager, pas une seconde procédure d’installation.

Mergeron Manager est le gestionnaire local de la pile Docker Mergeron. Il
installe, surveille et met à jour les composants gérés, avec sauvegarde et
restauration transactionnelles. La réparation arbitraire reste hors périmètre.
Son déploiement est séparé de l'application afin
qu'une panne ou une mise à jour de `mergeron-ui` ne supprime jamais le composant
chargé de l'observer.

Le [navigateur facultatif](navigateur-annote.md#gestion-par-le-manager), le
[CLI personnalisé protégé](operations/managed-codex-runtime.md) et les
[prévisualisations isolées](previsualisations-agents.md) possèdent leurs
procédures dédiées. Une nouvelle application ne met pas automatiquement à jour
un ancien Manager. Le remplacement du Manager lui-même reste une opération hôte.

## Chemin et espace disque des sauvegardes

L’onglet Sauvegarde permet de régler le nombre de copies à conserver : **10 par
défaut**, de 1 à 1 000. Le réglage est conservé dans l’état privé du Manager et
isolé par stack/environnement. Il nécessite une application et un Manager à jour.
L’enregistrement ne supprime rien immédiatement. Après chaque mise à jour réussie,
le Manager retire les copies les plus anciennes au-delà de la limite, sans toucher
à la sauvegarde courante, aux métadonnées inconnues ou protégées, aux journaux ni
aux quarantaines. Ces protections peuvent laisser plus de copies que la limite.
Un échec du nettoyage ne déclenche jamais de rollback d’une mise à jour réussie ;
les copies restantes seront réexaminées après une prochaine mise à jour réussie.
Les suppressions automatiques sont définitives.

La suppression invalide durablement le retour arrière avant de retirer uniquement
le sous-dossier `backup` sélectionné. Avec les capacités minimales `CHOWN` et
`DAC_READ_SEARCH`, le Manager reprend la propriété des seuls répertoires de cette
copie abandonnée, puis leur donne le mode `0700` pour les retirer. Il ne modifie
ni les permissions des fichiers (qui peuvent être des liens physiques), ni les
données actives, ni les autres sauvegardes ou quarantaines. Les liens symboliques
sont supprimés sans être suivis. Aucun ajout de `DAC_OVERRIDE` ou `FOWNER` n’est
nécessaire. Les journaux de transaction sont conservés.

Ces métadonnées nécessitent un Manager à jour, pas seulement une nouvelle image
de l’application. Le chemin hôte n’est affiché qu’après vérification du montage ;
sinon, le chemin interne au Manager est indiqué sans inventer de chemin serveur.

La taille allouée est calculée en arrière-plan pour les sauvegardes de transactions
terminées, dans une file unique. Le parcours lit les répertoires en flux et marque
une pause tous les 64 éléments : cette statistique administrative reste de basse
priorité et cède la place à une mise à jour ou une suppression. Elle ne suit pas
les liens symboliques et ne compte qu’une fois les liens physiques. Aucune liste
de tous les fichiers et de leurs inodes n’est gardée en mémoire.

Un calcul complet est conservé dans `backup-size.json`, à côté du sous-dossier
`backup`, sans modifier les données sauvegardées ni le journal de restauration.
Après redémarrage, le Manager réutilise ce résultat uniquement si sa portée
(pile, environnement, transaction) et l’identité de la racine correspondent.
Les sauvegardes de transactions terminées sont supposées immuables : ne pas
modifier leur contenu à la main. Un cache absent ou invalide déclenche un calcul,
jamais une suppression. Les sauvegardes historiques sont compatibles.

Pendant le calcul, l’interface indique « Calcul en cours… » et se réactualise
toutes les deux secondes. Une erreur réelle de lecture reste « Indisponible » et
peut être réessayée après une minute. Le total n’est affiché que si toutes les
tailles sont connues : aucune taille partielle n’est présentée comme un total.
Ces calculs ne changent ni les règles de conservation ni les protections de
suppression et ne suppriment aucune sauvegarde.

### Diagnostic de santé du Manager

La sonde vérifie une vraie réponse HTTP 200 complète sur le socket Unix `/healthz`.
Son échéance globale est de deux secondes, y compris l’établissement de la
connexion et la réception ; Docker conserve son délai de trois secondes, ses
trois échecs consécutifs et son intervalle de vingt secondes. Aucun délai ni
quota CPU/mémoire n’est augmenté pour masquer une indisponibilité.

Les échecs produisent des codes fixes (`managerHealthTimeout`,
`managerHealthUnavailable`, `managerHealthStatusInvalid`,
`managerHealthResponseError` ou `managerHealthResponseInvalid`), jamais le corps
des réponses ni des identifiants. Un dépassement de délai imposé par Docker avant
la fin du processus reste distinct de ces codes.

Si la boucle JavaScript est bloquée plus d’une seconde, le Manager journalise
`managerEventLoopDelayed`, au plus une fois par période de vingt secondes, avec
le retard, sa mémoire RSS et les compteurs cgroup disponibles. Ces compteurs sont
cumulatifs : ils aident à corréler bridage CPU, pression mémoire et retard, sans
attribuer automatiquement la cause à une opération. Un état Docker `unhealthy`
n’implique pas à lui seul un arrêt, un redémarrage ou un OOM.

## Installation initiale sécurisée

Le Manager sait désormais préparer une installation neuve et continue
d'inventorier les installations existantes. Il :

- inventorie `mergeron-ui`, `mergeron-ingress` et `mergeron-squid` avec l'API
  Docker locale ;
- contrôle l'état, la santé, l'image et les réseaux de chaque conteneur ;
- vérifie que `/home/codex` et `/workspaces` restent montés depuis un stockage
  persistant ;
- expose son résultat à l'application par un socket Unix local ;
- produit un plan avec empreinte d’état à revérifier avant toute installation ;
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
vie reste indépendant de `mergeron-ui`. Choisir des images publiées et validées ;
un tag stable ne reçoit pas automatiquement les nouveautés du canal `edge`.

## Barrières contre la perte de données

Le manifeste `manager/stack-manifest.json` décrit les composants acceptés,
les réseaux attendus et les montages protégés. Le Manager bloque
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
sans outil client arbitraire. L’installation limite les écritures à la création
des réseaux et conteneurs du manifeste et au démarrage de ces derniers.
La mise à jour ajoute uniquement l'arrêt, le renommage et la suppression des
conteneurs vérifiés de la pile sélectionnée, sans suppression des volumes ou
réseaux persistants de la pile. La sauvegarde, sa rétention et la restauration
ont leur périmètre de fichiers explicite. Les prévisualisations peuvent créer
puis retirer leurs propres conteneurs, réseaux et volumes éphémères, vérifiés
par identité et labels. Aucune opération Docker arbitraire n’est exposée par HTTP.

Le Manager conserve seulement `CHOWN` (création des dossiers applicatifs) et
`DAC_READ_SEARCH` (relecture des secrets privés appartenant à l'UID 11002).
Cette seconde capacité est indispensable à la reprise et à l'idempotence :
elle évite de rendre les secrets lisibles par tous, de changer leurs
propriétaires ou de les réécrire. Elle s'applique dans l'espace de montages du
Manager ; aucun montage de la racine de l'hôte n'est ajouté.

La définition de lancement du Manager monte le socket dans
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
défaut) doit préexister. Le Manager crée uniquement
les réseaux déclarés appartenant à la pile : `isolated`, `external` et `admin`
pour la base, complétés par le contrôle privé si le navigateur est géré.
Les images absentes sont téléchargées explicitement dans le plan avant la
création des conteneurs.

Les valeurs génériques sont `/srv/<préfixe>/state` pour les données et son
sous-dossier `appdata` pour les dossiers accessibles aux agents.
`MERGERON_APPDATA_ROOT` choisit ce montage explicitement. Les métadonnées d’une interface hôte ne sont générées qu’avec son intégration
explicitement activée ; `MERGERON_HOST_INTEGRATION=none` est le défaut.
`MERGERON_AUTH_MODE=native|authentik` choisit le modèle ingress uniquement à sa
création. `native` est le défaut des nouvelles installations, avec compte et mot
de passe actifs et OIDC désactivé, sans fournisseur d’identité imposé ; un modèle
existant n’est jamais remplacé. Voir [le raccordement réseau et SSO](installation-portable.md) pour les
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
`development` qui réutilise le préfixe de production. La sélection des conteneurs
reste strictement limitée à la pile choisie, sans adoption d’une autre instance.

Le domaine public ne participe jamais à la sélection des conteneurs. Il est
fourni séparément par `MERGERON_WEBUI_URL` dans le fichier d'environnement et
transmis à l'application sous `MERGERON_PUBLIC_URL`. Le dépôt ne contient donc
aucun domaine propre à une installation.

## Mise à jour transactionnelle et retour arrière

### Détection et confirmation dans l’interface

L’onglet **Version actuelle** détecte la révision de l’application ; l’onglet
**Mise à jour** présente les cartes des composants gérés et prépare les
[mises à jour individuelles](container-updates.md). La détection de l’application
vérifie automatiquement le canal `edge` (recette) ou `latest` (stable),
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

Les améliorations déjà installées se consultent séparément dans **Version
actuelle**, même lorsqu’aucune mise à jour n’est disponible : le dernier commit
de l’image exacte et un lien vers son historique restent accessibles. La
détection des autres composants compare également leur image de plateforme,
pas seulement le catalogue multi-architecture ; voir les
[conditions et limites](container-updates.md#technique).

« Mettre à jour » vérifie les prérequis, puis ouvre une confirmation
« Installer et redémarrer ». La cible détectée est épinglée par digest dans
le plan afin qu’un déplacement ultérieur du tag ne change pas l’image
confirmée. La sélection manuelle reste accessible dans les options avancées.
Le bouton « Enregistrer les paramètres de fonctionnement » est indépendant
et n’apparaît que lorsque ces paramètres ont été modifiés.

Le proxy sortant doit autoriser `ghcr.io`, en plus de GitHub et des domaines
`githubusercontent.com` déjà utilisés. Le modèle Squid livré inclut cette
règle. Les installations existantes conservent volontairement leur configuration :
ajouter `acl allowed_domains dstdomain ghcr.io` avant de tester la détection.
La comparaison NGINX/Squid utilise aussi exactement `auth.docker.io` et
`registry-1.docker.io` : ajouter chacun à `allowed_domains` dans une ancienne
configuration, valider puis recharger Squid. Aucun élargissement vers
les réseaux privés ou vers tous les domaines n’est nécessaire.

Les réglages généraux du serveur proposent un aperçu puis une confirmation de
mise à jour. L'opération continue dans le Manager lorsque l'application est
arrêtée ; son suivi reste disponible sur le socket local. Seuls les
administrateurs accèdent aux routes applicatives `/api/settings/manager/update`.

Après confirmation, une fenêtre **Suivi de la mise à jour** affiche l’étape
courante, un indicateur par étapes et le journal horodaté du Manager.
Elle interroge l’état toutes les deux secondes pendant l’opération. Il ne
s’agit pas d’un pourcentage de durée ni du flux brut des logs Docker : seules
les transitions journalisées, sans secrets, sont affichées.
Pendant l’arrêt de l’application, les dernières informations restent visibles
avec un message de reconnexion. Le journal est récupéré automatiquement après
redémarrage, y compris en cas de restauration ou d’intervention nécessaire.
Une coupure de connexion n’entraîne jamais une nouvelle demande d’installation.
Fermer la fenêtre n’annule rien ; **Voir le suivi et les logs** permet de la
rouvrir. Les restaurations et nouvelles tentatives de récupération utilisent
la même fenêtre, sans supprimer leurs confirmations de sécurité.

1. `POST /v1/update/plan` avec `images` et `backupMode` (`full`, `minimal`, `none`)
   sélectionne le périmètre de sauvegarde et des images des seuls dépôts
   autorisés. Tous les composants concernés doivent être sains, gérés ou explicitement
   adoptés, avec des noms canoniques et des montages compatibles. Une dérive
   d'adoption bloque l'opération. L'ordre variable des montages Docker ne
   modifie pas l'empreinte.
2. `POST /v1/update` avec cette empreinte et
   le même `backupMode` et la confirmation fournie par le plan
   (`UPDATE_WITHOUT_DATA_BACKUP` pour aucune sauvegarde,
   `UPDATE_WITH_ROLLBACK` sinon) lance l'opération en arrière-plan. Les
   images sont téléchargées avant l'arrêt et épinglées par empreinte publiée.
   Les spécifications Docker, réseaux et montages existants sont conservés.
3. Dans chaque environnement, le choix complet copie toutes les racines
   persistantes ; le choix minimal copie la base et les fichiers de configuration
   sélectionnés ; aucune sauvegarde saute entièrement la copie et l’inventaire
   récursif des données. Les appels anciens sans choix gardent leurs défauts.
   Le périmètre suit la
   [politique versionnée](sauvegarde-restauration.md#politique-des-mises-à-jour-du-manager).
   La copie reste sous `manager-state/updates/<opération>/backup`. L’espace libre
   est vérifié sur ce périmètre filtré. Les liens symboliques ne sont pas suivis ;
   les sockets temporaires sont ignorés, les autres fichiers spéciaux bloquent
   la sauvegarde. La copie conserve propriétaires, permissions ordinaires et
   dates, sans nécessiter de capacité supplémentaire.
4. Les anciens conteneurs sont conservés arrêtés sous un nom de secours. Les
   remplaçants démarrent dans l'ordre Squid, navigateur s’il est géré,
   application, ingress. Chacun doit devenir sain dans un délai borné, puis
   l’ensemble est contrôlé.
5. Après validation durable du résultat, seuls les anciens conteneurs arrêtés
   sont supprimés (`force=false`, `v=false`). Les images et sauvegardes restent
   présentes. Le référentiel d'adoption est actualisé uniquement s'il existait
   déjà ; aucune adoption implicite n'est créée.

Une erreur avant validation déclenche le redémarrage des anciens conteneurs.
Les éléments sauvegardés selon le choix enregistré sont aussi restaurés ;
sans sauvegarde, les données et migrations ne sont pas annulées, sans promesse
de compatibilité avec les anciennes images. Les données écrites dans les racines
restaurées par la version rejetée
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
sauvegarde, en Dev comme en production. Sans sauvegarde,
`confirmation=ROLLBACK_IMAGES_ONLY` remet les
images sans copie ni restauration de données. Cela annule, uniquement dans les
racines sauvegardées, les modifications applicatives postérieures à cette
sauvegarde, conservées séparément en quarantaine. Les versions plus anciennes
ne sont pas sélectionnables implicitement. Les sauvegardes suivent la rétention
configurée après une mise à jour réussie ayant créé une sauvegarde. Les journaux et quarantaines ne sont
pas purgés par cette rétention. Surveiller l’espace et conserver une sauvegarde
externe indépendante.

Le suivi public ne contient jamais les spécifications complètes, variables
d'environnement ni secrets du journal privé. L'installation, l'adoption, la
mise à jour et la récupération ne peuvent pas s'exécuter simultanément.

### Limites explicites

- Les fichiers externes montés sous `/appdata` ne sont ni sauvegardés ni
  restaurés ; ils ne sont jamais supprimés. Le rollback couvre les données
  applicatives sous `STATE_ROOT`, pas tous les fichiers de l'hôte.
- Les ACL et attributs étendus ne sont pas copiés. Un stockage utilisant ces
  mécanismes nécessite une sauvegarde externe adaptée avant mise à jour.
- Les mises à jour exigent les montages persistants de type bind et les noms
  attendus par le manifeste ; une configuration incompatible est refusée.
- Le Manager ne se met pas lui-même à jour et ne répare pas encore une pile
  arbitrairement endommagée.

## Étape suivante

Réparation limitée aux conteneurs et réseaux déclarés dans le manifeste.

Ne pas confondre les fichiers persistants de la pile et les ressources jetables
des aperçus : l’arrêt d’un aperçu retire uniquement ses conteneurs, réseaux et
volumes vérifiés par identité et labels. Les données applicatives couvertes
par `STATE_ROOT` sont restaurées lors du rollback transactionnel ; les dossiers
externes sous `/appdata` n’en font pas partie.
