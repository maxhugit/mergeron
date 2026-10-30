# Workspaces des projets

Chaque projet possède un workspace principal permanent dans `/workspaces/<id-du-projet>/`. L'identifiant est immuable : renommer le projet modifie uniquement son nom affiché. La création du projet ne propose plus de chemin personnalisé ; les autres dossiers peuvent être rattachés ensuite comme workspaces secondaires.

| Notion     | Rôle                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| Principal  | Dossier permanent appartenant au projet ; exactement un par projet       |
| Secondaire | Autre dossier rattaché au projet, détachable sans supprimer ses fichiers |
| Actif      | Référence stable vers une ressource du projet et un chemin relatif       |

Chaque agent, conversation simple, tâche et livrable possède son propre dossier actif. Le choix d'un dossier actif ne change pas le principal du projet. Parcourir un dossier dans l'explorateur ne change pas non plus le contexte d'exécution.

Dans la sidebar de l’agent, **Espace système** est présenté en premier aux
administrateurs, en lecture seule. **Espace de travail** contient les fichiers
du projet. L’étoile colorée indique le dossier de travail actif ; les menus
contextuels permettent de parcourir un autre emplacement sans le rendre actif.

À la création, un agent ou une conversation simple utilise le principal. Une tâche utilise le dossier explicitement choisi, celui de sa tâche parente, puis le principal. Un livrable utilise son propre sous-dossier dans `livrables/`. Lorsqu'un agent est lié à une tâche, le dossier actif de la tâche est prioritaire sur le défaut de l'agent.

Le serveur résout la ressource et le chemin relatif avant chaque nouvelle opération. Il vérifie leur appartenance au projet, l'existence du dossier, son confinement dans la ressource et l'absence de lien symbolique. Un changement s'applique aux opérations suivantes ; une exécution déjà lancée conserve le contexte résolu à son démarrage.

Une référence dont la ressource a été détachée, dont le dossier a disparu ou dont le chemin est devenu invalide passe à l'état **À résoudre**. Les nouvelles opérations concernées sont bloquées jusqu'à correction. Mergeron ne remplace jamais silencieusement cette référence par le principal.

## Organisation du principal

### Caches techniques et erreurs d’inspection Git

Le dépôt Mergeron exclut `.build-cache/` à toute profondeur dans `.gitignore`.
Les caches restent sur disque ; les fichiers déjà suivis ne sont pas retirés
de l’index. Pour une copie existante encore sur une ancienne révision, la même
règle peut être ajoutée à `.git/info/exclude` sans modifier les fichiers suivis.

Une inspection qui dépasse **1 Mio de sortie** indique désormais cette limite
et conseille de vérifier les fichiers non suivis et les exclusions. Un délai
dépassé affiche un message distinct. La limite n’est pas augmentée et aucun
diagnostic Git brut, susceptible de contenir un secret, n’est exposé.

Les agents peuvent [consulter les connexions de leur projet et publier avec Git
via le MCP interne](contexte-et-outils-agents.md#connexions-du-projet-et-utilisation-de-git).

### Structure

La structure actuelle est en version **3** et sépare deux racines :

| Racine / chemin | Usage |
| --- | --- |
| `/workspaces/<id>/` | Espace de travail permanent du projet |
| `AGENTS.md` | Explication de l’organisation du dossier de travail |
| `documents/`, `sources/`, `livrables/` | Contenu de travail utilisateur sous cette racine |
| `/workspaces/.mergeron-system/<id>/` | Espace système séparé, réservé aux administrateurs |
| `project.json` | Marqueur de propriété et version, sous la racine système |
| `knowledge/AGENTS.md`, `knowledge/CONNAISSANCES.md`, `knowledge/DECISIONS.md` | Connaissances partagées, sous la racine système |
| `history/` | Versions et historique applicatif, sous la racine système |

Les brouillons isolés des agents utilisent une racine privée sœur
`.mergeron-agent-drafts/<id>/`, pas un dossier de documents utilisateur.

L'onglet **Connaissances** des paramètres du projet permet aux administrateurs de consulter et modifier les trois fichiers Markdown avec un seul bouton d'enregistrement. Il contient aussi les propositions de mémoire des conversations. L’espace système ne s’édite pas via l’API de fichiers générique ; utiliser les actions métier dédiées. Un utilisateur non administrateur ne peut pas le consulter par un chemin direct.

Les dossiers de premier niveau `documents/`, `sources/` et `livrables/` constituent la structure imposée des projets en version 2. Les opérations génériques ne peuvent pas les renommer, les déplacer, les supprimer ou les remplacer. Leur contenu reste modifiable : création de sous-dossiers, édition, renommage et suppression de fichiers. Les mêmes protections s'appliquent aux chemins résolus par un alias symbolique. L'ancien nom `.webui` reste également réservé pour éviter sa réutilisation comme dossier utilisateur.

L'évolution distingue le principal, les dossiers actifs, les connexions externes, leurs copies Git et les transferts explicites. Son [découpage en cinq PR](evolution-workspaces.md) décrit les garanties appliquées à chaque étape. La synchronisation bidirectionnelle reste volontairement hors périmètre.

## Connaissance partagée entre conversations

Les fichiers sont relus dans l’espace système du projet à chaque nouveau tour Codex et à chaque réponse OpenAI des conversations simples du projet. Le workspace actif reste inchangé, y compris pour une conversation dans un secondaire. Les agents sont rattachés par leur association explicite au projet ; les exécutions éphémères utilisent le rattachement du workspace. Les conversations simples OpenAI utilisent directement leur identifiant de projet.

Les changements enregistrés s'appliquent au prochain échange d'une conversation existante. Une réponse déjà en cours continue avec son instantané de départ. Un instantané vide précise au modèle que les anciennes connaissances ont été retirées. La connaissance reste du contexte de projet et ne remplace pas les règles de sécurité ni les instructions de priorité supérieure.

Les conversations Codex reçoivent un bloc de contexte utilisateur distinct, préfixé par `<project_shared_knowledge>`, avant le message envoyé. Ce bloc peut être conservé dans l'historique brut Codex ; WebUI le retire du texte affiché et éditable du message utilisateur. Les titres et aperçus de branches continuent à utiliser la demande originale. Les conversations simples OpenAI transmettent le contexte à l'API sans l'enregistrer comme un message de conversation.

Chaque fichier est limité à **32 Kio de texte UTF-8**. Les noms sont fixes : l'API n'accepte pas de chemin libre. Les liens symboliques vers les fichiers ou les dossiers système sont refusés. Un document supprimé peut être recréé par l'éditeur ; un dossier principal manquant doit être restauré.

L'enregistrement utilise l'empreinte SHA-256 des trois contenus chargés. Deux onglets ne peuvent pas écraser silencieusement leurs modifications : une version périmée reçoit une erreur de conflit. Le brouillon reste présent et **Recharger et abandonner les modifications** recharge les contenus du serveur. Les brouillons restent en mémoire pendant la session lorsque l'on change d'onglet, mais ne sont pas une sauvegarde persistante.

Le serveur sérialise les enregistrements d'un projet, prépare des fichiers temporaires et remplace chaque document par renommage. Les lectures des conversations attendent la fin de l'enregistrement ; une erreur de remplacement déclenche une restauration des contenus précédents. Cette coordination concerne une seule instance WebUI et ne remplace pas une sauvegarde face à une coupure système ou une modification simultanée directe sur le disque.

API dédiée, réservée aux administrateurs : `GET /api/projects/:id/knowledge` retourne `{ files, revision, path }` ; `PUT` sur la même URL accepte `{ files, revision }` et retourne l'instantané enregistré. Aucun dossier secondaire n'est copié ou modifié.

## Propositions de mémoire et validation

Les conversations peuvent proposer un fait durable, une règle ou une décision, spontanément lorsqu'une information est clairement établie, ou sur demande explicite, par exemple : « Propose de mémoriser cette décision pour le projet ». Cette fonction ne lance pas une seconde analyse IA après chaque réponse : elle capture une suggestion structurée émise dans la réponse elle-même.

Dans l'onglet **Connaissances**, la section **Propositions de mémoire** présente la date, le document concerné, le statut et un lien vers la conversation d'origine. **Examiner la proposition** affiche le document avant et après la modification prévue. Les propositions sont paginées, et la liste se rafraîchit automatiquement quand elle est affichée.

| Action                                          | Effet                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Enregistrer les modifications de la proposition | Modifie uniquement le brouillon proposé, pas les connaissances partagées                    |
| Accepter et appliquer                           | Écrit le contenu validé dans le principal et enregistre l'identité du validateur et la date |
| Refuser                                         | Conserve la proposition dans l'historique, sans modifier les fichiers partagés              |

Une modification locale de la proposition doit être enregistrée avant son acceptation. Un brouillon manuel de connaissances doit également être enregistré ou abandonné avant validation. L'éditeur de connaissances est temporairement bloqué pendant une action de validation pour éviter de perdre une saisie en cours.

Chaque proposition conserve sa version de départ. Si les connaissances ont changé entre-temps, l'acceptation est refusée et la proposition reste en attente. Refuser cette proposition périmée puis demander une nouvelle suggestion dans la conversation, qui recevra les connaissances actuelles au prochain échange. Deux validateurs ne peuvent pas accepter ou refuser silencieusement une même version concurrente. Une proposition déjà traitée ne peut pas être appliquée une seconde fois.

Les fichiers de connaissance restent dans `knowledge/` de l’espace système séparé. Les versions de départ et les propositions sont des données applicatives conservées dans SQLite, comme les tâches et les conversations simples ; sauvegarder la base avec les espaces de travail et système. Les propositions survivent à un redémarrage et sont supprimées avec leur projet. La suppression d'une conversation ne modifie pas la référence historique conservée dans une proposition, mais son lien peut alors ne plus être disponible.

### Capture et API

Le contexte envoyé au modèle décrit le format `webui-memory-proposal`. Un bloc JSON borné précise une révision connue du projet, un titre, un fichier autorisé et soit un ajout, soit un remplacement d'un fragment exact et unique. Le serveur valide ces champs, les limites et la révision avant de créer une proposition en attente. Les suggestions identiques déjà en attente et les relectures d'une même réponse ne créent pas de doublons.

Pour les agents Codex, seuls les messages d'assistant terminés dans un tour réussi et une conversation durable du projet sont capturés. Les commentaires, échecs et exécutions éphémères de planification ne créent pas de propositions. Les conversations simples, avec OpenAI ou Codex, utilisent l'identifiant de leur message d'assistant enregistré comme origine. Une erreur de stockage d'une proposition ne bloque pas la réponse de conversation. Un format invalide est ignoré ; si aucune suggestion n'apparaît, demander à la conversation de la reformuler.

Le bloc structuré reste dans l'historique brut, mais s'affiche comme une suggestion lisible dans WebUI. Cette présentation ne constitue pas une preuve d'acceptation : le statut de la proposition dans les paramètres est la référence.

Routes réservées aux administrateurs : `GET /api/projects/:id/knowledge/proposals?offset=0`, `GET /api/projects/:id/knowledge/proposals/:proposalId`, et `PATCH` sur cette dernière URL avec `{ action: "edit" | "accept" | "reject", version, content? }`. La liste expose seulement les métadonnées par pages de 50 ; les contenus sont chargés à l'ouverture d'une proposition. La coordination des validations concerne une instance WebUI.

## Migration de l'existant

La migration SQL `0031_knowledge_proposals` ajoute les instantanés transmis aux agents et les propositions avec leur historique de validation. Elle ne modifie pas les fichiers de connaissances existants.

Les migrations SQL existantes fournissent `workspace_layout_version` et imposent au plus un workspace marqué principal par projet. Avant de démarrer les automatisations, le service projets migre les projets de version 0 :

1. Il crée `/workspaces/<id>/` et sa structure réservée.
2. Il conserve l'ancien dossier comme secondaire, en ajoutant son rattachement s'il manquait.
3. Une transaction remplace le chemin principal du projet, normalise les rôles et inscrit la version de structure courante (aujourd’hui 3).

Aucun fichier existant n'est déplacé ou supprimé. Les chemins des conversations d'agents, des conversations simples et des tâches restent inchangés. Les conversations simples utilisant Codex exécutent désormais dans leur chemin conservé, plutôt que dans le nouveau principal.

La migration SQL `0046_graceful_white_queen` ajoute les références de dossiers actifs. Au démarrage, un rattrapage idempotent associe chaque chemin absolu existant à la ressource locale la plus précise du même projet et conserve son chemin relatif. Les agents, conversations simples, tâches et livrables ne sont ni déplacés ni réaffectés. Une référence qui ne peut plus être résolue reste visible à corriger au lieu d'être remplacée.

Les principaux existants en version 1 ou 2 contiennent encore un dossier
interne `.webui` ou `.mergeron`. La migration vers la version 3 vérifie leur
marqueur de propriété et leur structure, puis déplace les données internes
dans `/workspaces/.mergeron-system/<id>/`. Elle conserve connaissances,
historiques et fichiers utilisateur, adapte les références historiques des
livrables et d’OnlyOffice, et garde les anciens chemins internes protégés.
Les anciens brouillons sont archivés dans l’espace système ; les nouveaux
utilisent l’espace privé séparé. Les documents, sources et livrables restent
dans le dossier de travail. Le fichier racine `AGENTS.md` n’est actualisé que
s’il correspond exactement à l’ancien texte généré ; les instructions
personnalisées sont conservées.

La migration peut être relancée après une interruption entre les déplacements
et la transaction en base. Des dossiers anciens et nouveaux présents en même
temps, un marqueur absent ou étranger au projet, une collision ou un lien
symbolique réservé la bloquent plutôt que de fusionner ou écraser les contenus.
Corriger la cause après sauvegarde ; ne pas supprimer un dossier système pour
forcer le démarrage. Sauvegarder la base et toutes ces racines ensemble avant
déploiement ; un simple renommage manuel ne suffit pas.

## Git dans la sidebar de l’agent

Une connexion Git est présentée par une **entrée unique**, avec un indicateur
de copie locale disponible ou absente pour l’agent. Le menu « … » distingue
parcours local, parcours distant et ouverture du graphe des branches/commits.
Le graphe, les comparaisons et les fichiers distants s’ouvrent dans des onglets
à côté de Conversation. Un fichier GitHub est explicitement en lecture seule.

Une seule copie locale peut être attribuée à un agent de travail. Changer de
branche ne crée pas une seconde copie. Les actions de création, attribution,
libération ou suppression gardent leurs confirmations et leurs blocages quand
la copie est utilisée ; aucun travail non publié n’est supprimé implicitement.

Le panneau sépare **Local**, **GitHub** et **Synchronisation**.
Dans l’onglet **Modifications**, deux zones partagent la hauteur disponible :
les modifications à préparer en haut et les fichiers prévus dans le commit en
bas. Chacune dispose de son propre défilement ; les titres, le bouton
**Préparer la sélection** et l’action **Commit…** restent accessibles.
Un fichier partiellement préparé apparaît dans les deux listes, avec une
comparaison propre à chaque version. Retirer un fichier du commit ne supprime
pas ses modifications locales.
Dans Local, préparer les fichiers puis vérifier l’index avant de confirmer le
commit ; l’auteur vient de la personne connectée, pas d’un champ libre.
Publier les commits est une action distincte dans Synchronisation. L’état
local, les branches distantes déjà connues et les informations GitHub ne sont
pas présentés comme un fetch ou un push automatique. Le [MCP Git](contexte-et-outils-agents.md#connexions-du-projet-et-utilisation-de-git)
permet le même travail borné sans rendre `.git` modifiable dans le terminal.

Un principal déjà migré qui disparaît du disque n'est pas recréé automatiquement : la réconciliation le signale comme non résolu et ne promeut aucun secondaire. Restaurer le dossier depuis la sauvegarde avant de reprendre les opérations concernées.

## Changement de dossier avant le premier message

Une conversation chargée et détenue par Mergeron peut choisir une copie Git avant
son premier message, sans fabriquer d'échange ni relancer `thread/resume` sur un
historique qui n'existe pas encore. Le serveur exige le refus structuré précis de
`thread/turns/list` indiquant un agent non matérialisé : une page vide persistée,
une erreur de permissions ou un historique disparu ne sont pas assimilés à ce cas.

Le dossier choisi est appliqué au premier vrai `turn/start`, avec les contrôles de
projet, de chemin et de sandbox habituels. Le moteur n'est conservé sans redémarrage
que si les transports MCP et les applications autorisées sont strictement identiques
dans le même projet. Une configuration native modifiée bloque ce raccourci, sans
détruire la conversation neuve. Les conversations déjà matérialisées conservent leur
procédure de reprise et de renouvellement des connexions.

L'association enregistre ensemble le dossier actif, le rattachement au projet et le
chemin des échanges suivants. En cas d'échec, seule une réservation de copie créée
par cette tentative est libérée ; une réservation existante, notamment celle créée
pendant le clonage, reste conservée. Deux associations simultanées d'un même agent
de travail sont refusées, y compris via ses branches de conversation.

## Suppression et exploitation

### Création d’un agent dans un projet

La création depuis le projet utilise une seule requête serveur qui crée la
conversation dans le dossier choisi puis enregistre son rattachement au projet
et son dossier actif avant de répondre. Une conversation neuve n’a pas encore
d’historique sur disque : elle ne doit pas être reprise simplement pour réappliquer
le même dossier. Un échec de rattachement n’est pas annoncé comme une création
réussie ; le serveur tente d’archiver uniquement la conversation qu’il vient de
créer. Les appels de rattachement de conversations existantes restent inchangés.

La présence d’une conversation sous un projet dans la sidebar peut aussi provenir
de son ancien chemin de travail. Ce classement historique n’est pas un rattachement
enregistré : il ne suffit pas à la proposer dans les listes d’affectation aux
livrables. Les anciens cas doivent être rattachés explicitement après vérification,
sans migration automatique fondée uniquement sur un chemin partagé.

Le principal ne peut pas être détaché, remplacé, renommé, déplacé ou supprimé seul via les API Mergeron. Les opérations génériques sur un dossier parent qui supprimeraient le principal sont également refusées. Cette protection ne remplace pas les permissions système face à un accès direct au serveur, ni le confinement des commandes d'un agent disposant d'un accès au disque.

La suppression confirmée du projet conserve le choix existant : préserver ses dossiers ou sélectionner ceux à supprimer physiquement, principal compris. Les secondaires détachés restent sur disque. Les activités qui les référencent passent à l'état **À résoudre** et ne basculent pas vers le principal.

Avant de déployer, sauvegarder la base et le volume `/workspaces` ensemble, y compris les racines système et brouillons séparées. Le stockage contenant `/workspaces` doit être persistant et accessible en écriture au serveur. La migration concerne une seule instance Mergeron : arrêter les autres instances partageant les volumes et éviter les modifications directes sur disque pendant l'opération. Un retour vers une ancienne version nécessite la restauration cohérente de cette sauvegarde, car l'ancienne version attend une autre organisation et d’autres chemins d’historique ; un simple renommage du dossier ne suffit pas.
