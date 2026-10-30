# Emplacements d’exécution des agents — PR 3/4

## Choix explicite

Le sélecteur de dossier de la conversation envoie un identifiant normalisé
`local:<id>` à `PUT /api/projects/:id/agents/:threadId`. L’API accepte aussi un
chemin relatif contenu dans cet emplacement. Les anciens appels `resourceId` et
`workspacePath` restent compatibles, mais subissent les mêmes validations côté
serveur. Les sélections ambiguës sont refusées, sans repli automatique.

Un emplacement autorisé pour l’exécution est un dossier local rattaché au même
projet, cohérent avec le modèle normalisé, présent et valide sur le disque. Une
connexion Git/SSH/SFTP/FTP distante n’est pas un dossier d’exécution. Une copie
locale explicite reste nécessaire. Les emplacements de projets différents ne
sont pas interchangeables. Le dossier d’une tâche liée reste prioritaire sur le
dossier par défaut de sa conversation, comme auparavant.

## Contrôles appliqués aux conversations existantes

Les contrôles sont effectués à la création, à la reprise et avant chaque tour :

- dossier existant et confinement du chemin relatif ;
- absence de composant symbolique dans le dossier relatif ;
- refus des alias vers un projet, y compris si le dernier composant manque,
  plutôt que de les traiter comme une exécution sans projet ;
- cohérence entre l’emplacement normalisé, son dossier historique et son projet ;
- copie prête et connexion source toujours rattachée au même projet et activée ;
- lecture seule de la source ou de l’emplacement maintenue même si le client
  demande l’accès complet.

Une référence invalide ou révoquée bloque la nouvelle opération ; elle ne choisit
ni l’espace principal ni les outils globaux. La lecture des intégrations MCP est
précédée du contrôle d’emplacement et suivie d’une nouvelle vérification. Une
vérification finale est aussi faite après la préparation asynchrone, juste avant
l’envoi natif. L’identité d’emplacement, la révision source, le dossier effectif
et la lecture seule participent à l’empreinte de session : un ancien contexte
natif n’est pas réutilisé après leur changement. Le mécanisme existant exige un
état inactif avant de remplacer ce contexte.

Le journal d’exécution conserve les anciens identifiants et ajoute `locationId`.
Les protections de publication versionnée et les restrictions MCP du projet ne
sont pas remplacées ni assouplies.

## Limites et transition

Cette PR contrôle le **contexte d’exécution** et conserve les droits existants ;
elle n’ajoute pas une matrice d’ACL par personne/agent ni une nouvelle isolation
de tout le système de fichiers en mode accès complet. Le périmètre de fichiers
effectivement accessible reste régi par les protections et le sandbox existants.
Les documents publiés conservent leur protection spécifique, y compris en accès
complet. Une révocation bloque les prochaines opérations ; elle n’interrompt
pas de force un tour déjà en cours et n’annule pas ses effets passés.

L’explorateur peut naviguer sans modifier le dossier actif. Les conversions
complètes de l’explorateur, des transferts, de Git et de l’import/export restent
dans la PR4. Aucune nouvelle migration ni déplacement de données n’est requis
ici ; les écritures historiques et la synchronisation ajoutée par la PR2 restent
en place.

## Copie Git créée par la conversation

Pour un travail autorisé sur une connexion Git du projet, l’agent peut appeler
`create_project_git_copy` après `list_project_connections`. Le serveur choisit
le projet et le propriétaire depuis la conversation authentifiée ; l’appel
n’accepte ni identifiant de conversation, ni chemin local, ni URL ou secret.
La copie est clonée avec les identifiants conservés côté serveur, enregistrée
et réservée à cette conversation dans la même transaction. Les versions d’un
message appartiennent toujours au même agent de travail.

L’outil ne déplace pas le dossier actif : une conversation peut rester à la
racine du projet et posséder sa copie de sources. Une seule copie est autorisée
par agent. Réutiliser la sienne lorsqu’elle existe ; ne pas cloner manuellement,
prendre la copie d’un autre agent ou tenter de contourner un refus de propriété.
`requestId` doit rester identique lors d’une reprise. Si l’issue est inconnue,
consulter l’inventaire avant toute autre création ; ne pas changer l’identifiant
pour relancer aveuglément le clonage.

Le rattachement est immédiat. Les permissions natives sont renouvelées au
prochain tour ; l’agent ne doit pas contourner un refus d’écriture entre-temps.
Le renouvellement d’un moteur chargé reste soumis au contrôle des agents actifs.
Si les droits changent avant le tout premier tour d’une conversation encore
non persistée par le moteur, le renouvellement est refusé pour préserver cette
conversation : rétablir son contexte initial ou créer un agent dans le dossier
voulu. Un agent créé directement dans une copie libre conserve le même profil
lorsque cette copie lui est réservée.

## Protection des fichiers entre agents

Les conversations de projet reçoivent un profil natif de fichiers : les copies
gérées sont en lecture seule, avec une exception d’écriture pour la seule copie
prête appartenant à cet agent, si la connexion et l’emplacement l’autorisent.
La protection couvre aussi un `cwd` placé sur le dossier parent du projet et
les noms physiques des chemins. Le conteneur `sources/.external` reste protégé
pour les copies créées pendant un tour. Les métadonnées Git restent protégées
par le moteur ; préparer commits et publications avec les outils Git dédiés.

Le serveur impose ce profil aux démarrages, reprises et tours suivants, vérifie
l’accusé de réception du moteur, puis revalide la propriété avant l’exécution.
Il fournit uniquement les racines natives du dossier courant et, le cas échéant,
du brouillon documentaire de ce tour. Les mises à jour de politique et les
escalades qui retireraient la protection sont refusées ; les conversations
protégées utilisent `approvalPolicy=never`. Les intégrations MCP et leurs
contrôles d’accès restent distincts.

Cette frontière nécessite les profils natifs du runtime Codex géré actuel
(0.164.0-mergeron.1). Un ancien moteur sans accusé de réception échoue avant le
tour avec `GIT_COPY_ISOLATION_UNAVAILABLE`, sans repli permissif. Les profils
personnalisés existants autres que `:workspace` et `:read-only` sont également
refusés tant que leur intersection avec cette protection n’est pas prise en
charge. La lecture seule reste conservée ; aucune variable d’installation ne
désactive implicitement cette protection.

Vérifications : tests des services de copies, outils MCP, politique et tours de
conversation ; puis `python3 scripts/smoke-test-git-copy-isolation.py
/CHEMIN/DU/BINAIRE/CODEX_GERE` sur Linux dans un contexte autorisé. Ce dernier
utilise seulement des fichiers temporaires, un fournisseur local factice et
aucun tour de modèle : il vérifie le profil reconnu, l’écriture dans sa copie,
le refus des écritures et renommages d’une copie voisine, les alias symboliques
et le maintien de la lecture seule.

## PR simultanées sur une même connexion Git

Plusieurs agents peuvent utiliser la **même connexion Git**, chacun avec sa
copie gérée et sa branche de travail. Ils peuvent préparer leurs fichiers,
créer leurs commits, pousser leurs branches et ouvrir leurs PR en parallèle.
Les identifiants de la connexion restent conservés côté serveur.

Le verrou des opérations MCP est limité au **chemin physique de la copie**.
Une publication verrouille également le couple dépôt configuré / branche
distante : deux branches différentes du même dépôt peuvent être publiées
simultanément ; deux opérations sur la même copie ou la même branche distante
restent exclusives. Les pushes conservent leurs contrôles d’état et ne forcent
jamais l’historique distant.

Cette concurrence n’est autorisée qu’après confirmation du profil natif de
chaque conversation active. Le serveur conserve une preuve de ses racines
protégées et de sa copie éventuellement modifiable, liée à la génération du
moteur. Un nouveau tour d’un agent protégé peut commencer pendant l’opération
sur une autre copie. Un tour visant la copie verrouillée, un autre propriétaire
de cette copie ou une session sans preuve d’isolation bloque l’opération.
Un remplacement du moteur invalide toutes ces preuves. Les mutations manuelles
et opérations de maintenance conservent leur verrou exclusif global.

Un refus du verrou avant tout début d’opération peut être retenté avec le
**même `requestId`**, après libération du verrou. Une erreur après début de
l’opération reste une issue inconnue : inspecter l’état avant toute reprise,
sans changer arbitrairement l’identifiant ni republier aveuglément.

## Mettre une PR à jour et résoudre ses conflits depuis un agent

Les opérations suivantes complètent les outils MCP Git. Elles utilisent la
connexion configurée et la copie appartenant à la conversation appelante ;
elles ne donnent jamais un accès direct en écriture à `.git`. Les mutations
exigent une demande humaine explicite, une session administrateur active et
un tour autorisé en écriture. `userRequest` rappelle cette demande mais ne
constitue pas une autorisation à lui seul.

| Outil / opération | Usage et paramètres spécifiques |
| --- | --- |
| `read_project_git / branches` | Observer les branches distantes et leurs révisions immuables. |
| `prepare_project_git / fetch_branch` | Fournir `name` et `revision` observés. Récupère cette branche dans `refs/remotes/mergeron/<name>`, sans remplacer une branche locale ni changer le dossier de travail. |
| `prepare_project_git / create_branch` | Créer une branche locale neuve avec `name`. Par défaut, part de HEAD ; `startRef` et `revision` permettent de partir d'une référence locale ou distante observée dans `local_status`. |
| `prepare_project_git / switch_branch` | Passer sur une branche locale existante avec son `name` et sa `revision` observés. Exige un dossier de travail propre. |
| `prepare_project_git / start_merge` | Intégrer une `revision` immuable dans la branche active, à partir d'un dossier propre. La fusion reste sans commit pour permettre sa revue, même sans conflit. |
| `read_project_git / local_merge_status` | Lire le parent de fusion `mergeHead`, les chemins et les entrées d'index non résolues, avec HEAD et l'empreinte actuelle. |
| `read_project_git / local_conflict` | Avec `path`, lire les contenus base (stage 1), courant (stage 2) et entrant (stage 3), lorsqu'ils existent. Contenus texte limités à 128 Kio par entrée ; les contenus binaires et sous-modules ne sont pas renvoyés comme texte. |
| `prepare_project_git / continue_merge` | Avec `revision` égale au `mergeHead` observé et `message`, créer un commit à deux parents à partir du seul index revu, sous l'identité de la personne connectée. Refuse les entrées non résolues. |
| `prepare_project_git / abort_merge` | Annuler la fusion dont le parent observé est `revision`. **Abandonne les modifications de résolution** : l'agent doit obtenir une autorisation humaine explicite pour cette perte de travail. Ne sert pas à annuler un rebase ou un cherry-pick. |
| `read_project_git / pull_request` | Avec `number`, lire le titre, la description, `updatedAt`, les branches, les révisions et l'état d'une PR GitHub. Une description dépassant la limite est signalée. |
| `publish_project_git / update_pull_request` | Modifier uniquement le titre et la description de la PR ouverte correspondant à la branche et au commit de cette copie. Fournir `number`, `title`, `description` et `expectedUpdatedAt` observé ; aucun changement de base, de statut brouillon ou fusion distante. |

Chaque mutation conserve les paramètres communs `connectionId`, `copyId`,
`expectedBranch`, `expectedHead`, `fingerprint`, `requestId` et `userRequest`.
Les noms de branche, commandes shell, URL réseau ou identités d'auteur ne
peuvent pas remplacer les cibles contrôlées par le serveur.

Pour intégrer `main` dans une branche de PR :

1. Lire `branches` et `local_status`, puis appeler `fetch_branch` avec le nom
   `main` et sa révision distante observée. Relire `local_status` après cet
   appel, même si HEAD n'a pas changé.
2. Sur la branche de PR, appeler `start_merge` avec la révision récupérée.
   Un résultat avec conflits est un résultat confirmé, pas une erreur réseau :
   réutiliser le même `requestId` renvoie ce résultat sans relancer la fusion.
3. Lire `local_merge_status` et, au besoin, `local_conflict` pour les chemins
   concernés. Modifier les fichiers de sa propre copie, puis utiliser
   `stage_review` et `stage` avec l'empreinte de revue inchangée. Les suppressions
   résolues peuvent également être préparées.
4. Lire **tout** `local_staged_diff` sans `path` : la fusion peut avoir préparé
   automatiquement d'autres fichiers. Appeler ensuite `continue_merge` avec
   l'empreinte de cet index et le parent observé.
5. Relire `local_status`, pousser le nouveau commit avec `push` ; la PR existante
   suit sa branche. Si son texte doit être mis à jour, lire `pull_request` puis
   appeler `update_pull_request` avec le texte complet souhaité.

La récupération réseau utilise un dépôt temporaire avec une configuration
propre, sans helpers, réécritures d'URL ou hooks du dépôt de travail. Elle vérifie
la révision téléchargée et modifie la référence distante locale par transaction
Git avec comparaison de l'ancienne valeur. Les fusions refusent les pilotes
personnalisés, désactivent hooks, filtres, autostash et rerere, et ne lancent pas
les scripts du projet. Elles ne réécrivent aucun commit et aucun push n'est forcé.

Une erreur après début d'opération reste `GIT_OUTCOME_UNKNOWN` pour le registre
d'idempotence : inspecter l'état local, la fusion ou la PR avant de décider de la
suite. L'API GitHub ne propose pas de comparaison atomique sur les métadonnées
éditées : le serveur revérifie `updatedAt` avant PATCH et verrouille sa branche,
mais une modification humaine concurrente reste possible. Relire la PR avant
une reprise. Les opérations destructrices générales (`reset`, nettoyage forcé,
suppression forcée), le rebase et la fusion d'une PR dans sa branche cible ne
sont pas exposés par ces outils.
