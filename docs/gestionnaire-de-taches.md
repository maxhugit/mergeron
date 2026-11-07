# Gestionnaire de tâches

Ce guide décrit le fonctionnement implémenté dans le dépôt : organisation des
tâches, planning, assistance IA et exécution des sous-tâches par Codex.

## Organisation dans un projet

Un projet regroupe des espaces de travail et des ressources. Le gestionnaire
est une ressource de type `task_board` ; un projet peut en posséder plusieurs.
Chaque tableau possède ses propres tâches, statuts, dépendances, paramètres
et journal. Le gestionnaire d’automatisations est une autre ressource
(`automation_board`), distincte du tableau de tâches.

Pour commencer :

1. Ajouter un gestionnaire de tâches au projet.
2. Définir les tâches principales et leur dossier de travail.
3. Ajouter des sous-tâches manuelles ou exécutables par un agent.
4. Renseigner les dates, estimations, responsables et critères de validation.
5. Suivre le tableau ou le planning, puis contrôler les résultats des agents.

## Tâches et sous-tâches

Une tâche contient un titre, une description, une priorité, un responsable
facultatif, des labels, un avancement de 0 à 100 %, une estimation et des
dates facultatives. Elle peut aussi préciser des conditions de validation.

| Élément             | Tâche principale                          | Sous-tâche                       |
| ------------------- | ----------------------------------------- | -------------------------------- |
| Organisation        | Colonne du tableau                        | Rattachée à une tâche principale |
| Exécution           | Manuelle                                  | Manuelle ou agent Codex          |
| Priorité et dossier | Choisis sur la tâche                      | Hérités du parent                |
| Dépendances         | Autres tâches principales du même tableau | Non prises en charge             |
| Fichier lié         | Possible                                  | Pas de fichier lié propre        |
| Niveau inférieur    | Sous-tâches                               | Aucun niveau supplémentaire      |

Un responsable doit être une personne active ajoutée aux participants du projet.
Retirer un participant ne supprime pas ses affectations historiques.

Le dossier d’une tâche doit appartenir à un espace de travail du projet ou se
trouver dans un de ses sous-dossiers. Sans dossier explicite, le lancement
de l’agent utilise celui du projet.

### Statuts

Les colonnes créées initialement sont :

- Actions non assignées ;
- À faire ;
- En cours ;
- Bloqué ;
- À valider ;
- Terminé.

La colonne système « Actions non assignées » ne peut pas être supprimée.
Les autres colonnes peuvent être personnalisées. Supprimer une colonne
replace ses tâches dans la colonne système.

Les sous-tâches ont des états fixes : À faire (`todo`), Commencée
(`started`), À valider (`review`), Terminée (`done`) et Annulée
(`cancelled`). Leurs couleurs sont personnalisables, mais leurs états finaux
restent Terminée et Annulée.

Les statuts finaux des tâches principales sont configurables ; par défaut,
il s’agit des colonnes dont le type interne est `done`. Le serveur refuse de
placer un parent dans un statut final tant qu’une sous-tâche n’est ni terminée
ni annulée. La fin des sous-tâches ne déplace pas automatiquement le parent
dans une colonne finale.

### Estimation et avancement

Les estimations sont stockées en minutes et saisies ou affichées en heures.

Pour un parent ayant des sous-tâches :

- sa charge est la somme des estimations des sous-tâches ;
- son avancement est la moyenne arithmétique de leurs pourcentages, arrondie ;
- cette moyenne n’est pas pondérée par les estimations ;
- son avancement ne se modifie pas directement.

Exemple : deux sous-tâches estimées à 1 h et 9 h, avancées à 100 % et 0 %,
donnent un parent de 10 h avancé à 50 %.

Passer une sous-tâche à Terminée ou Annulée fixe son avancement à 100 %.
Ce pourcentage représente donc aussi la clôture, pas uniquement du travail
réalisé. Supprimer la dernière sous-tâche remet les agrégats du parent à zéro.

## Les quatre vues

| Vue      | Utilisation                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------- |
| Conseils | Analyse du tableau et proposition de travail selon le temps disponible                              |
| Tableau  | Cartes par statut, sous-tâches, recherche, filtre de priorité et déplacement des cartes             |
| Planning | Gantt des tâches et sous-tâches datées, liens de dépendance et modification du planning             |
| Journal  | Créations, modifications et suppressions, avec valeurs avant/après pour les changements enregistrés |

La recherche du tableau porte sur le titre, la description et les labels des
tâches principales. Le tableau est relu toutes les cinq secondes.

Le Gantt propose plusieurs échelles de temps et un ajustement à la période.
Ses liens sont de type fin-vers-début. Les changements de dates et de
dépendances sont persistés par l’API.

### Dates et dépendances

Une date de début ne peut pas être postérieure à la date de fin. Les dates
renseignées d’une sous-tâche doivent rester dans les bornes renseignées du
parent. Réduire ces bornes peut donc être refusé si une sous-tâche les dépasse.

Les dépendances restent dans le même tableau, entre tâches principales ;
les cycles sont refusés. L’interface affiche une dépendance bloquante si un
prédécesseur n’est pas dans un statut final. Il s’agit d’un suivi du planning :
les dépendances ne constituent pas un ordonnanceur lançant les agents.

## Assistance IA à la planification

Ces fonctions passent par `SimpleChatService` et l’API OpenAI
(`/v1/responses`), avec le modèle du chat simple. Elles nécessitent sa clé API ;
l’authentification du CLI Codex par un compte ChatGPT ne suffit pas à elle seule.

| Fonction                    | Résultat                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Générer un plan             | Propositions de tâches, sous-tâches, estimations et dépendances à partir d’une demande           |
| Découper une tâche          | Jusqu’à dix propositions de sous-tâches, avec mode manuel ou agent et conditions de validation   |
| Replanifier                 | Propositions de priorité, charge, dates et dépendances des tâches principales existantes         |
| Conseils                    | Analyse de santé, alertes et recommandations                                                     |
| Travail selon disponibilité | Sélection proposée avec temps recommandé, pour une disponibilité supérieure à 0 et au plus 168 h |

Les propositions de création et de replanification sont présentées avant
application. L’utilisateur peut les examiner ; les tâches à replanifier peuvent
être sélectionnées. Les conseils n’exécutent pas les tâches.

Le découpage limite les labels proposés à ceux configurés dans le tableau et
ne crée pas de dépendances entre sous-tâches. Pour un parent déjà découpé, la
replanification conserve la charge calculée depuis ses enfants.

L’application d’un ensemble de propositions effectue plusieurs appels
successifs. Une erreur peut laisser les premières modifications enregistrées :
relire le tableau avant de recommencer.

## Exécution par un agent Codex

Seules les sous-tâches peuvent être confiées à un agent. Le lancement depuis
l’interface suit ces étapes :

1. Enregistrer la sous-tâche avec la révision observée (`expectedUpdatedAt`). Une modification concurrente est refusée avec HTTP 409 : relire la tâche avant de sauvegarder.
2. Demander le lancement à `POST /tasks/:taskId/agent`, avec un identifiant de demande et la révision enregistrée. Le serveur réserve durablement un lancement par tâche avant tout appel au moteur.
3. Créer la conversation dans le dossier autorisé, conserver immédiatement son identifiant, puis l’associer au projet et à la sous-tâche.
4. Envoyer les instructions et ouvrir la conversation existante pour suivre le travail.

Les tâches et les livrables utilisent le même service de lancement et le même journal durable. Pour un livrable, la création d’une éventuelle sous-tâche et la réservation du lancement sont atomiques, avant l’appel natif. Une réservation unique par sous-tâche empêche une double création même si les deux gestionnaires sont utilisés simultanément. Une demande non résolue reste prioritaire si la version du livrable change ; un nouvel identifiant de requête ne contourne pas cette protection.

Une réponse perdue ne déclenche aucune nouvelle création ni aucun renvoi d’instructions. La fiche expose **Reprise du lancement de l’agent**, également après rechargement :

- Demande encore en cours : attendre sa confirmation.
- Agent identifié, association interrompue : terminer l’association avec le même agent, puis ouvrir sa conversation.
- Création non confirmée : actualiser l’inventaire et choisir explicitement un agent disponible dans le même dossier. Une liste périmée ou un agent occupé n’autorise pas la réassociation.
- Envoi incertain : ouvrir et vérifier la conversation, puis confirmer la vérification. Aucun tour n’est renvoyé.
- Association devenue impossible ou non souhaitée : après vérification d’un agent identifié, conserver cet agent sans terminer l’association et clore la demande. L’agent et son historique ne sont ni archivés ni supprimés. Une création sans identifiant connu ne peut pas être close de cette façon.

Les reprises exigent le même utilisateur actif, les droits d’exécution et les révisions observées du reçu et de sa destination. Les anciens reçus de lancement sont transférés dans la migration 0074, avec leurs identifiants, propriétaire et incertitudes conservés ; ils ne sont pas rejoués. La suppression explicite d’un agent libère ses reçus. Supprimer une tâche ne supprime jamais l’agent.

Les instructions demandent à l’agent de résumer son travail et ses
vérifications sans se déclarer définitivement validé. La restriction de
dossier écrite dans le message ne remplace pas les protections du moteur.

Le serveur projette les événements du moteur et réconcilie les métadonnées au démarrage et après leur actualisation, même sans gestionnaire ouvert. Les vues ouvertes se rafraîchissent toutes les cinq secondes, sans scrutation en arrière-plan quand l’onglet est masqué.

| État observé                                               | État du gestionnaire                      |
| ---------------------------------------------------------- | ----------------------------------------- |
| Conversation active, y compris un agent auparavant `ready` | `running`, sous-tâche En cours            |
| Attente d’approbation ou de réponse utilisateur            | `waiting`                                 |
| Conversation devenue inactive après exécution              | `review`, sous-tâche À valider            |
| Tour échoué                                                | `error`                                   |
| Métadonnées absentes ou conversation non chargée           | Aucun état final déduit                   |
| Travail déjà validé ou terminé                             | Conservé, jamais rouvert par un événement |

Un agent inactif ne prouve pas que le résultat est correct : la revue reste
nécessaire. L’avancement n’est pas calculé à partir des messages de Codex.

### Validation et suppression

L’action de validation envoie `agentState: validated` et `subtaskStatus: done`. Elle conserve la conversation, l’historique, le lien et la copie Git de l’agent. La validation fonctionnelle n’autorise aucune destruction de données.

Supprimer une tâche supprime ses sous-tâches et ses liens de tâche, mais conserve les agents, leurs historiques et leurs copies Git. Leur suppression reste une action explicite distincte, avec les contrôles habituels. Le journal du tableau conserve les entrées de suppression. Une notification explicite de suppression d’agent nettoie ses liens ; une absence temporaire des métadonnées ne le fait pas.

Les agents existent indépendamment des tâches et des livrables. Seules les sous-tâches peuvent recevoir un agent. Un même agent peut être affecté explicitement à un livrable et à une sous-tâche, à condition que le livrable soit rattaché à la tâche principale de cette sous-tâche. Cette règle est vérifiée dans les deux sens, lors des affectations et des changements de rattachement. Pour déplacer un élément vers une autre tâche principale, retirer d’abord l’affectation incompatible ; l’agent et son historique restent conservés.

Une tâche principale ne peut être associée qu’à un seul livrable principal, quelle que soit la route d’édition utilisée. Un agent affecté doit appartenir au projet et ne peut être affecté à deux tâches. Une tâche qui porte un livrable ou possède des enfants ne peut devenir une sous-tâche. Le contexte MCP, les livrables et le bandeau « Lié à » utilisent les mêmes liens calculés, incluant les sous-tâches de la tâche principale du livrable ; consulter un dossier ne crée pas de lien.

## Paramètres et droits d’accès

Les paramètres du tableau sont enregistrés dans
`project_resources.config.taskBoardSettings` : priorités, labels, couleurs,
statut et priorité par défaut, colonnes vides masquées, statuts finaux et
confirmation de suppression.

Le statut choisi par défaut dans l’interface est appliqué après création :
l’API crée d’abord une tâche principale dans « Actions non assignées ».

Les routes sont soumises à `PlatformAccessGuard`. Dans cette version, les
écritures sur les personnes, les automatisations et les routes d’exécution
`/threads` exigent un administrateur. Le lancement d’un agent depuis le
gestionnaire utilise ces routes : le tableau ne contourne donc pas cette
restriction pour un utilisateur standard. Les chemins sont également contrôlés
par la politique d’accès aux espaces de travail.

## Stockage et maintenance

Les données du gestionnaire sont persistées dans SQLite, via Drizzle :

- `projects`, `project_resources`, `project_workspaces` ;
- `project_tasks`, `project_task_statuses` ;
- `project_task_dependencies`, `project_task_activity` ;
- `people`, `project_participants`, `project_agent_threads`.

Le chemin de base est donné par `WEBUI_DB_PATH`, sinon par
`CODEX_HOME/codex-webui.sqlite`, sinon par
`~/.codex/codex-webui.sqlite`. Les migrations du dossier `drizzle/` sont
appliquées au démarrage. Pour sauvegarder les tâches, préserver cette base
selon la [procédure de sauvegarde](sauvegarde-restauration.md), ainsi que les
fichiers des espaces de travail et les données Codex utiles.

Le journal retrace les opérations enregistrées par le service ; toutes les
synchronisations internes ne créent pas une entrée. Il ne constitue pas un
journal d’audit exhaustif des actions de chaque utilisateur.

## Repères dans le code

| Fichier                                                                              | Responsabilité                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Interface du gestionnaire](../web/src/components/projects/project-task-manager.tsx) | Vues, formulaires, Gantt, propositions IA et lancement des agents         |
| [Gantt](../web/src/components/projects/stable-project-gantt.tsx)                     | Intégration du composant de planning                                      |
| [Types et client HTTP](../web/src/lib/projects-api.ts)                               | Contrats côté navigateur                                                  |
| [Contrôleur](../src/projects/projects.controller.ts)                                 | Routes sous `/api/projects`                                               |
| [Service projets](../src/projects/projects.service.ts)                               | Validation, persistance, agrégats et dépendances                          |
| [Projection d’exécution](../src/projects/project-task-runtime.service.ts)            | États des tâches depuis les événements et les instantanés frais du moteur |
| [Lancement durable](../src/projects/project-agent-launch.service.ts)                 | Réservation et reprise sans duplication des lancements                    |
| [Service chat simple](../src/simple-chat/simple-chat.service.ts)                     | Appels IA de planification et de conseil                                  |
| [Schéma SQLite](../src/database/schema.ts)                                           | Tables et relations                                                       |
| [Contrôle d’accès](../src/auth/platform-access.guard.ts)                             | Autorisations des routes                                                  |

Les routes du tableau partagent le préfixe
`/api/projects/:id/resources/:resourceId` :

| Méthode et suffixe                                   | Fonction                                          |
| ---------------------------------------------------- | ------------------------------------------------- |
| `GET /`                                              | Lire le tableau et recalculer les parents         |
| `POST /tasks`                                        | Créer une tâche ou sous-tâche                     |
| `PATCH /tasks/:taskId`                               | Modifier, lier une conversation ou valider        |
| `POST /tasks/:taskId/agent`                          | Lancer ou retrouver un agent avec un reçu durable |
| `DELETE /tasks/:taskId`                              | Supprimer une tâche et ses sous-tâches            |
| `POST /statuses`, `PATCH/DELETE /statuses/:statusId` | Gérer les colonnes                                |
| `POST /ai-plan`                                      | Proposer un plan                                  |
| `POST /ai-replan`                                    | Proposer une replanification                      |
| `POST /ai-advice`                                    | Obtenir analyse ou sélection de travail           |
| `POST /tasks/:taskId/ai-subtasks`                    | Proposer un découpage                             |
| `PATCH /`                                            | Modifier la ressource et ses paramètres           |
