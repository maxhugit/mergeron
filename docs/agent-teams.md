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
  dernières équipes de cette conversation, sous forme de résumés sans consignes
  ni résultats ; `launchAvailable` reste faux.
- `GET /api/projects/:projectId/agent-teams/:teamId` : détail de la mission et des
  affectations. Les droits du projet et du coordinateur sont revérifiés.

Aucun endpoint de lancement ou de modification n'est installé à cette étape.
Le service ne crée pas de nouveaux agents permanents dans la navigation.
Au redémarrage, les états en cours deviennent inconnus ; ils ne sont pas relancés.

## Panneau Équipe

Le bouton Équipe, dans la barre d’outils de la conversation, ouvre un panneau à
droite sur ordinateur et un volet sur téléphone. La conversation reste montée.
Chaque mission montre ses membres, leurs états et leurs dépendances. Sélectionner
un membre affiche son travail confié et son résultat, sous forme de texte.

Les résumés et le détail sélectionné sont actualisés toutes les cinq secondes
uniquement lorsque le panneau et sa conversation sont actifs. Les requêtes sont
annulables et leurs clés de cache comprennent le projet et le coordinateur. Une
erreur de lecture masque les anciens détails plutôt que de présenter un résultat
potentiellement devenu inaccessible. À cette étape, le panneau ne lance aucun
travail et ne propose aucune action d’approbation.

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

## Contrôle et reprise de l’observation

Le panneau propose aux administrateurs personnels un arrêt confirmé et une
vérification de l’état réel. L’arrêt vise exclusivement le tour enregistré du
coordinateur et les sous-agents dont le parent natif a été vérifié. Il conserve
les fichiers et les résultats ; il ne crée ni nouveau tour ni reprise implicite.
Après une coupure, un état inconnu reste inconnu tant qu’un résultat natif ne
permet pas de le confirmer. Une conversation inactive ne prouve pas la fin d’une
mission. Les commandes et les réponses aux approbations ne sont jamais rejouées.

Les demandes affichées utilisent les mêmes composants, identifiants immuables et
contrôles de génération que le chat. Les lecteurs voient le besoin d’intervention
sans recevoir les paramètres sensibles d’une approbation. L’historique des messages
d’un membre est chargé sur demande, par pages, après vérification de sa filiation.
Les routes `POST :teamId/stop` et `POST :teamId/reconcile` sont réservées aux
administrateurs ; `GET :teamId/assignments/:assignmentId/history` est soumis aux
droits du projet et de la conversation coordinatrice.
