# Équipes d’agents — développement progressif

Cette fonctionnalité est en cours de développement. Le socle de stockage ne
déclenche aucun agent et n’accorde aucune permission.

## Fonctionnement prévu

Une conversation existante sert de coordinateur. Une mission d’équipe appartient
à son projet et contient des affectations avec un rôle, des instructions et des
dépendances. Les analyses pourront avancer en parallèle ; le coordinateur restera
responsable de la rédaction et de la synthèse pendant cette première phase.

Les sous-agents temporaires seront regroupés sous la mission et ne remplaceront
pas les agents permanents du projet. Le livrable ne sera pas validé automatiquement
à la fin des analyses.

## Livraison

1. Stockage persistant et suivi des observations natives.
2. Panneau Équipe en consultation.
3. Arrêt, approbations, erreurs et réconciliation après reconnexion.
4. Profils et lancement, après validation des contrôles précédents.
5. Rattachement aux tâches et livrables.

Le développement actuel introduit les tables `agent_teams` et
`agent_team_assignments` par la migration `0066_agent_teams`. Le service
`AgentTeamStore` est installé par `AgentTeamsModule`. Un observateur projette
les événements natifs `item/completed` de type `collabAgentToolCall` : seuls les
appels `spawnAgent` réussis, émis par un coordinateur connu du projet, créent des
affectations. Une bifurcation de conversation n'est pas adoptée. Les appels
inconnus et la délégation imbriquée ne sont pas automatiquement rattachés.

Deux lectures authentifiées sont disponibles :

- `GET /api/projects/:projectId/agent-teams?coordinator=:threadId` : les 50
  dernières équipes de cette conversation ; `launchAvailable` reste faux.
- `GET /api/projects/:projectId/agent-teams/:teamId` : détail de la mission et des
  affectations. Les droits du projet et du coordinateur sont revérifiés.

Aucun endpoint de lancement ou de modification n'est installé à cette étape.
Le service ne crée pas de nouveaux agents permanents dans la navigation.
Au redémarrage, les états en cours deviennent inconnus ; ils ne sont pas relancés.

## Garanties du stockage

- Le coordinateur doit être rattaché au projet.
- Une clé de requête rend la création idempotente ; un contenu différent avec la
  même clé est refusé.
- Les dépendances inexistantes et les cycles sont refusés avant insertion.
- Une liaison à un sous-agent exige une observation native de son parent ; une
  simple bifurcation ne constitue pas cette preuve. Cette méthode doit uniquement
  être appelée par l’adaptateur de confiance, jamais avec une preuve fournie par
  le navigateur ou par du contenu d’agent.
- Lier une conversation ne prouve ni son démarrage ni son achèvement. Son état
  initial reste inconnu jusqu’à une observation explicite.
- Un événement tardif ne remplace pas un résultat terminal.

La vérification des droits de la personne, de l’accès au projet et au coordinateur
est effectuée par le service d’entrée. Le stockage ne fournit pas à lui seul une
autorisation et n'est pas exposé directement aux clients.

Les sous-agents natifs héritent des permissions du parent. Une consigne de rôle
ne constitue pas une isolation en lecture seule. L’écriture parallèle avec des
worktrees et l’intégration de leurs contributions ne font pas partie de cette
première phase.

## Vérification

Les tests de `src/agent-teams/agent-team-store.spec.ts` utilisent SQLite et la
chaîne réelle des migrations. Ils n’appellent aucun modèle et n’utilisent aucune
connexion à la dev ou à la prod.
