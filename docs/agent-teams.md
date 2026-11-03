# Équipes d’agents — développement progressif

Cette fonctionnalité est développée en cinq étapes. Une mission enregistrée
n’accorde aucune permission : le lancement passe par les contrôles natifs existants.

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
  ni résultats ; `launchAvailable` indique si la personne peut préparer une mission.
- `GET /api/projects/:projectId/agent-teams/:teamId` : détail de la mission et des
  affectations. Les droits du projet et du coordinateur sont revérifiés.

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
potentiellement devenu inaccessible. Les actions de lancement et d’approbation
exigent une intervention explicite et les droits correspondants.

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

## Préparation et lancement

Un administrateur personnel peut préparer une équipe depuis le panneau : objectif,
rôles, consignes et dépendances sont relus avant le lancement. Les profils du projet
peuvent être enregistrés séparément ; chaque mission conserve sa propre copie.
Changer les profils ne modifie jamais une mission existante. Les dépendances
inconnues et cycliques sont refusées. Les rôles Sources et Exigences analysent ;
le coordinateur rédige, puis le rôle Vérification relit la synthèse.

Le bouton de lancement ouvre une confirmation présentant tout le plan. Le serveur
vérifie les droits, l’absence de travail et de demande en attente, ainsi que
l’activation des sous-agents natifs. Il ne réactive pas une fonctionnalité désactivée
par l’administrateur. Une seule mission planifiée non résolue est admise par
coordinateur. Les sous-agents ne sont pas ajoutés à la liste des agents permanents.

L’adaptateur appelle `ThreadsService.startTurn` avec une garde avant l’envoi.
La préparation durable passe de `draft` à `preparing`, puis à `dispatching` juste
avant le RPC. Le tour natif est rattaché même si son événement arrive avant
l’accusé de réception. Un envoi incertain devient `unknown` et bloque un nouveau
lancement ; aucun démarrage n’est rejoué après reconnexion. Une erreur prouvée
avant l’envoi rend le brouillon réutilisable.

La politique de connexion applique `agents.max_threads = 2` pendant les missions
actives ou incertaines. Ce nom est l’alias compatible du plafond natif par session.
Une session chargée ne rechargeant pas sa configuration via `thread/resume`, le
renouvellement utilise la barrière de redémarrage contrôlé existante : aucun agent
actif n’est interrompu pour installer cette limite. Une conversation neuve sans
premier tour peut refuser ce changement ; envoyez d’abord un message normal, puis
réessayez le lancement. Aucun fichier de configuration du projet n’est modifié.

Les rôles sont des instructions, pas des bacs à sable : ils héritent réellement des
permissions du parent. La première phase demande aux enfants de ne pas écrire ;
elle ne fournit pas encore d’isolation d’écriture par worktree. Le coordinateur
reste responsable des écritures, de la consolidation et du respect des dépendances.
Un rôle non démarré ou sans résultat confirmé ne devient pas automatiquement réussi.

Routes supplémentaires : `GET/PUT profiles?coordinator=…`,
`POST prepare?coordinator=…` et `POST :teamId/launch`. Toutes les écritures exigent
un administrateur personnel, sans usurpation. Les profils sont bornés à 12 missions,
et la concurrence native à deux enfants ouverts. Les marqueurs
`[mergeron-assignment:UUID]` associent les observations natives aux affectations ;
ils ne servent jamais de preuve d’autorisation.

Le test `node scripts/test-native-agent-teams.cjs` démarre un vrai app-server dans
un dossier temporaire sans compte, avec un fournisseur Responses déterministe
sur localhost. Il vérifie la limite native, le refus du troisième enfant, la
filiation et l’historique paginé. Il est exécuté dans les contrôles backend CI.
Le contrat a aussi été vérifié localement avec les CLI 0.153.2 et 0.166.0-alpha.5.1.
