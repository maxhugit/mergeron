# Contexte projet et outils des agents de travail

## Fonctionnement pour l’utilisateur

Un agent de travail rattaché à un projet reçoit désormais, **à chaque nouvel
échange**, une fiche de contexte préparée par Mergeron :

- nom et identifiant du projet, indépendamment du dossier Git actif ;
- dossier de travail effectif de la conversation ;
- gestionnaires de tâches et de livrables disponibles ;
- nombre de tâches et de livrables accessibles, avec les 25 premiers de chaque
  catégorie (tri stable par gestionnaire/identifiant pour les tâches, identifiant
  pour les livrables) ;
- tâches et livrables déjà liés à cette conversation.

Les connaissances partagées, les objectifs du livrable lié et les consignes de
versionnement restent transmis. Une conversation existante reçoit ces nouveautés
au prochain échange : il n’est pas nécessaire de recréer l’agent.

### Consulter le projet

Exemples de demandes : « Dans quel projet travailles-tu ? », « Liste les tâches
du projet », « Quels livrables concernent la présentation client ? » ou
« Consulte les critères du livrable Présentation ».

L’agent dispose d’outils de consultation à la demande pour compléter le résumé,
rechercher par titre et parcourir les listes par pages de 50 éléments. Les
lectures consultent les données courantes, et non une copie de la base exportée
dans le dossier de travail. Les gestionnaires internes d’exécution sont exclus.
Un livrable confidentiel inaccessible n’apparaît ni dans les listes, ni dans les
compteurs, ni dans les détails, ni dans la fiche injectée.

### Créer une tâche ou un livrable

Exemples :

- « Crée une tâche Préparer la présentation client, avec ces critères… »
- « Crée un livrable Présentation client dans Gestion des livrables. »
- « Découpe cette tâche en une sous-tâche de relecture. »

L’agent appelle les services métier de Mergeron. Il crée donc une vraie tâche ou
un vrai livrable, visible dans le gestionnaire, et retourne un lien vers celui-ci.
La tâche est principale par défaut. Une sous-tâche exige un parent appartenant au
même gestionnaire ; les sous-sous-tâches restent interdites.

La consigne donnée à l’agent est de créer **uniquement sur demande explicite de
l’utilisateur**. Le champ de justification de l’outil est journalisé ; ce n’est
pas une preuve automatique que la demande est explicite. Cette version n’ajoute
pas de seconde fenêtre de confirmation humaine. La vérification sémantique de
la demande repose sur l’agent ; l’autorisation technique, elle, est vérifiée par
le serveur à chaque appel.

La création n’affecte pas automatiquement un agent, ne change pas son dossier
actif, ne démarre pas une exécution et n’effectue aucune validation. Si le
gestionnaire nécessaire manque, l’agent doit demander à l’utilisateur de
l’ajouter ; l’outil ne crée pas de gestionnaire implicitement.

### Documents et versions

Créer un livrable crée sa fiche et son dossier, **pas une version de document**.
Les documents conservés continuent à passer par « Enregistrer une nouvelle
version » : brouillon isolé, accusé de réception serveur, versionnement et
contrôles existants. Les outils projet n’acceptent ni chemin arbitraire, ni
contenu de document, ni action de validation. La protection des documents
publiés, y compris en accès complet, n’est pas assouplie.

### Permissions et disponibilité

Le projet est déduit du rattachement explicite de la conversation. L’agent ne
peut pas choisir un autre projet dans les arguments d’un outil. Le serveur
revérifie l’identité active, l’accès à la conversation et au projet, puis la
confidentialité des livrables. La création requiert l’autorité administrateur
déjà nécessaire pour exécuter les agents de travail ; aucun droit supplémentaire
n’est accordé à un compte standard.

Le canal d’outils utilise l’environnement isolé de publication existant :

- la protection `MERGERON_PUBLISHED_DOCUMENT_PROTECTION` doit être opérationnelle
  et le projet doit posséder un espace principal migré ;
- Python 3 est nécessaire au petit client intégré (présent dans l’image Docker) ;
- les consultations fonctionnent aussi en sandbox lecture seule : le client
  n’écrit aucun fichier et n’utilise pas le réseau ;
- les créations requièrent un mode d’exécution modifiable (workspace ou accès
  complet). Elles sont refusées côté serveur en lecture seule. Mergeron ne
  transforme jamais implicitement une sandbox lecture seule en workspace modifiable.

Les outils sont internes à Mergeron, pas un connecteur MCP externe activé à
l’insu du projet. Ils ne réactivent ni `codex_apps`, ni Home Assistant, ni les
autres intégrations désactivées. Les conversations simples ne sont pas des
agents de travail et ne reçoivent pas ce canal.

## Architecture technique

### 1. Injection légère à chaque échange

`ThreadsService.startTurn()` appelle `ProjectAgentToolsService.context()` avant
`turn/start`. La fiche `<mergeron_project_context>` est ajoutée avant le message
utilisateur, à côté du contexte de connaissances et de publication. Le message
utilisateur original et le dossier choisi restent inchangés.

Le rattachement vient de `project_agent_threads`, jamais d’une déduction à partir
du chemin courant. Les titres/descriptions et les résultats sont explicitement
marqués comme données non fiables, pas comme instructions ou permissions.

`DeliverablesService.agentCatalog()` filtre les droits sans charger les historiques
de documents. Les listes d’outils retournent seulement identifiants, titres,
gestionnaires et statuts ; les outils de détail donnent description et critères.

### 2. Outils métier intégrés et transport

Le protocole app-server utilisé ici ne fournit pas, dans ses paramètres exposés
de démarrage/reprise, d’enregistrement d’outils dynamiques ; le gestionnaire RPC
refuse actuellement `item/tool/call`. Cette implémentation réutilise donc le
canal de publication déjà pris en charge, plutôt que de supposer l’existence
d’une API native ou de donner un jeton REST/SQL à l’agent.

`DocumentPublicationService.prepare()` prépare un répertoire de brouillon isolé
pour une session bornée et y installe `mergeron-tools.py`. Le contexte explique
à l’agent comment appeler ce client. Même sans gestionnaire de livrables, le
canal peut être préparé pour consulter le projet et créer des tâches.

Le client est une CLI sans écriture, à trois étapes :

1. `python3 <client> --encode '<JSON>'` fournit les paramètres en base64url.
2. Une commande terminal **séparée**, exactement sous la forme
   `python3 "<chemin absolu du client>" --request BASE64`, valide les paramètres
   et se termine avec `status: submitted`. Cela ne signifie pas « créé ».
3. Une autre commande `python3 <client> --result REQUEST_ID` attend le résultat
   serveur et le retourne sur sa sortie standard.

Le véritable point d’entrée n’est **pas un fichier écrit par l’agent**. Le serveur
admet uniquement un événement app-server authentifié `item/completed`, portant
la conversation et le tour en cours, une commande terminée avec code de sortie
zéro et le chemin exact du client de cette session. Il décode les paramètres
directement depuis cette commande, en mémoire. Les commandes indirectes,
substitutions shell, préfixes `env`/`cd`, pipes et commandes composées sont
refusés. Une notification dupliquée n’admet pas une seconde opération.

Ainsi, écrire un faux `project-tool-request.json` ne fait rien ; appeler le
client d’une autre conversation depuis son propre agent ne donne pas accès aux
droits de cette autre conversation. Une commande refusée par les protections
terminal, non terminée ou en échec n’autorise aucune opération métier.

Le serveur valide le schéma et exécute l’opération dans le contexte d’accès de
l’échange authentifié. Il vérifie l’inode du répertoire de session, limite les
paramètres à 32 Kio et applique un quota. La réponse est écrite par renommage
atomique dans `project-tool-REQUEST_ID-result.json`. Ces réponses temporaires
sont distinctes des documents conservés et de leur versionnement. Le client ne
contient aucun secret et n’écrit aucun fichier de requête ou de verrou.

La session est limitée à une heure et à 100 commandes d’outils admises
(quota séparé des 20 publications). Elle est révoquée en cas d’arrêt,
d’échec d’exécution, de fermeture/archivage/suppression de conversation ou de
redémarrage du processus. Un nouvel échange terminé renouvelle le canal ; un
changement d’identité, de session de simulation ou de mode d’écriture le fait
également. Le rattachement au projet et les permissions sont revérifiés avant
chaque opération, ainsi qu’avant le commit d’une création de livrable après ses
opérations asynchrones de préparation.

### 3. Contrat des outils

Tous les appels utilisent un `requestId` de 1 à 100 caractères alphanumériques,
tirets ou underscores. Le client peut en générer un pour une lecture. Pour une
création, l’agent doit choisir un identifiant stable et le conserver pour toute
relance du même appel.

| Outil                | Arguments métier                                                                             | Résultat                                    |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `get_project`        | aucun                                                                                        | projet et gestionnaires accessibles         |
| `list_tasks`         | `resourceId`, `query`, `offset` facultatifs                                                  | `items`, `total`, `nextOffset`              |
| `get_task`           | `id`, `resourceId` facultatif                                                                | détail de la tâche                          |
| `list_deliverables`  | `resourceId`, `query`, `offset` facultatifs                                                  | `items`, `total`, `nextOffset`              |
| `get_deliverable`    | `id`, `resourceId` facultatif                                                                | détail du livrable accessible               |
| `create_task`        | `resourceId`, `title`, `userRequest` ; `description`, `criteria`, `parentTaskId` facultatifs | identifiant, titre, lien, `status: created` |
| `create_deliverable` | `resourceId`, `title`, `userRequest` ; `description`, `criteria` facultatifs                 | identifiant, titre, lien, `status: created` |

Exemple de requête, envoyé par le client dont le chemin est fourni dans le
contexte de l’agent :

```json
{
  "requestId": "presentation-client-01",
  "tool": "create_deliverable",
  "resourceId": "identifiant-du-gestionnaire",
  "title": "Présentation client",
  "description": "Présentation du programme PLM",
  "criteria": "Inclure le planning et les risques",
  "userRequest": "L’utilisateur a demandé de créer ce livrable"
}
```

Les arguments `projectId`, chemins, identifiants de personnes, statuts et
affectations arbitraires sont refusés. Les titres sont limités à 200 caractères,
les descriptions/critères à 10 000, la justification à 2 000 et la recherche à 200. Les listes sont limitées à 50 éléments par page ; la recherche porte sur
le titre, sans distinction de casse.

### 4. Services métier, audit et idempotence

`create_task` appelle `ProjectsService.createTask()` ; `create_deliverable`
appelle `DeliverablesService.create()`. Les validations de parenté, statuts,
champs, dossiers et événements existantes restent appliquées.

Une entrée `agent_created` est ajoutée au journal avec l’identifiant de
conversation, celui de la requête, la personne appelante, la justification et
l’administrateur réel en cas de simulation. Les événements liés aux livrables
utilisent le canal `deliverable_history`, filtré selon la confidentialité.

La migration `0058_project_agent_tools` ajoute `project_agent_tool_requests`.
La clé primaire `(project_id, thread_id, request_id)` est réclamée **avant** la
création. Elle conserve l’empreinte des paramètres, la personne et le résultat.

- Même identifiant, mêmes paramètres et même personne : restitution du résultat,
  sans nouvelle création (et recontrôle d’accès pour le livrable).
- Même identifiant avec paramètres/personne différents : conflit.
- Création dont le résultat n’a pas été enregistré après une panne : état
  non confirmé, **pas de rejeu automatique**. Une vérification dans le
  gestionnaire est nécessaire avant toute nouvelle création.
- Le client expire après 60 secondes : il ne doit pas annoncer un succès ou
  changer d’identifiant pour recommencer. Un résultat de création n’est acquis
  que lorsque `status: ok` contient `result.status: created`.

Ce mécanisme privilégie l’absence de doublon. Il ne promet pas une transaction
unique entre SQLite et le système de fichiers : une panne après la création
peut laisser un élément existant sans accusé de réception, et un refus après
préparation peut laisser un dossier vide. Les brouillons ne sont pas supprimés.

### 5. Tests et exploitation

Les suites concernées sont :

```sh
pnpm exec vitest run \
  src/project-knowledge/project-agent-tools.service.spec.ts \
  src/project-knowledge/project-agent-tool-client.spec.ts \
  src/document-publication/document-publication.service.spec.ts \
  src/threads/threads.service.spec.ts \
  src/deliverables/deliverables.service.spec.ts \
  src/project-knowledge/project-knowledge.service.spec.ts
```

Elles couvrent contexte rafraîchi, pagination, confidentialité, créations réelles,
refus hors projet, champs dangereux, droits retirés, idempotence durable, panne
après commit, révocation avant commit, admission liée à la conversation,
refus des fichiers forgés et commandes composées, client Python sans écriture,
lecture seule et maintien du versionnement des documents. Le démarrage réel du
graphe de dépendances reste couvert par `src/app.module.spec.ts`.

Après déploiement : vérifier dans une conversation existante le nom du projet,
la liste des tâches et des livrables ; demander explicitement une création de
test, contrôler l’élément et son journal ; vérifier qu’un appel répété avec le
même identifiant ne crée rien de plus. Effectuer ces essais dans un projet de
test, avec un gestionnaire existant et le mode d’exécution approprié.
