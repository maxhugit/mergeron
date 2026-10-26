# Emplacements et connexions — modèle transitoire (PR 2/4)

## Modèle séparé

- `project_connections` décrit le protocole, l’adresse et l’état d’une connexion
  externe. Aucun chemin, droit d’exécution ni secret en clair n’y est copié.
- `project_locations` décrit un dossier local géré, un dossier local associé ou
  une racine distante. Plusieurs racines peuvent référencer la même connexion.
  Les clés étrangères composites interdisent les associations entre projets.
- Les copies de travail restent des dossiers locaux ; l’inventaire les identifie
  via `workingCopyId`, sans modifier leurs révisions ou leurs associations.

La migration `0054` est une phase **additive**, pas le basculement de l’autorité
d’écriture. Les opérations existantes continuent d’écrire dans
`project_workspaces` et `project_workspace_resources`. Quatre triggers répercutent
leurs insertions et modifications dans le modèle séparé au sein de la même
transaction. Les suppressions se propagent par clés étrangères. Une suppression
de connexion n’efface pas la copie locale qui en était issue.

Les connexions existantes restent distinctes, même avec une adresse identique :
aucune fusion implicite de configurations ou d’identifiants. Chaque ressource
externe devient une connexion de même identifiant et un emplacement par défaut
`remote:<id>`. Chaque dossier local devient `local:<id>`, même si son ancienne
ressource de compatibilité n’a pas encore été créée par une consultation.

## Compatibilité et confidentialité

`GET /api/projects/:projectId/locations` expose l’inventaire normalisé en lecture
seule aux personnes ayant déjà accès au projet. Il ne crée aucun droit et ne
renvoie ni secrets chiffrés, ni secrets en clair, ni messages d’erreur réseau.
Les paramètres d’accès des emplacements sont descriptifs dans cette étape : les
contrôles existants restent l’autorité. Aucun agent ne reçoit de nouvel accès.

Les secrets restent dans `project_workspace_secrets`, avec le même identifiant,
les mêmes octets chiffrés et la même clé. Les chemins physiques, dossiers actifs,
conversations, règles de transfert et historiques ne sont pas réécrits. Aucune
opération réseau ni opération sur les fichiers n’est exécutée par la migration.

Les nouvelles tables sont des projections de transition : elles sont exclues du
ZIP et reconstruites par les triggers à l’import des données historiques. Les
connexions importées restent désactivées et leurs secrets ne voyagent pas. La
PR4 traitera l’adaptation complète des fonctionnalités et du format de transport.

## Retour arrière

Conserver une sauvegarde SQLite cohérente avant toute mise à jour. Une ancienne
version peut utiliser les anciennes tables sans migration inverse : celles-ci
n’ont été ni supprimées ni modifiées dans leur contenu.

Pour retirer aussi les ajouts de structure, **arrêter tous les processus Mergeron
et les autres écrivains**, sauvegarder la base (WAL compris via un outil SQLite
adapté), puis exécuter depuis ce checkout :

```sh
node scripts/rollback-project-locations.mjs /chemin/explicite/mergeron.sqlite --backup-confirmed
```

L’outil vérifie que `0054` est exactement la dernière migration appliquée, refuse
les emplacements non représentables par l’ancien modèle, et retire uniquement
les quatre triggers, les deux projections, leur index auxiliaire et l’entrée
correspondante du journal Drizzle, dans une transaction. Il ne supprime ni les
anciennes données ni les fichiers. Démarrer ensuite une version antérieure ;
redémarrer cette version réappliquerait normalement `0054`.

Les tests couvrent la migration depuis `0053`, sa réapplication sans doublons,
les opérations existantes, les cascades, l’isolation par projet, le retour arrière,
le refus de retirer une migration plus récente et la reconstruction à l’import.
Les PR3 et PR4 restent nécessaires pour basculer les consommateurs et l’autorité
d’écriture ; ne pas écrire directement dans les nouvelles tables entre-temps.
