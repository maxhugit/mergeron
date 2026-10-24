# Accès aux données des projets

Les administrateurs peuvent consulter tous les projets. Un utilisateur standard
actif accède uniquement aux projets dont il est participant. Documents, tâches,
livrables, conversations et connaissances héritent de ce périmètre.

## Application côté serveur

`IdentityService` fournit la politique commune pour les projets, conversations,
chemins et sessions documentaires. Le garde global protège les accès directs,
y compris les identifiants transmis dans le corps des requêtes. L'intercepteur
`AccessContextInterceptor` propage une identité isolée par requête aux services
métier avec `AsyncLocalStorage`. Les appels internes des traitements de fond
n'empruntent pas l'identité d'un navigateur.

Les listes de projets, tableaux de bord et conversations sont filtrées côté
serveur. La pagination des conversations porte sur les éléments autorisés.
Les branches exigent aussi l'accès aux messages hérités. Un lien ne donne pas
accès à sa cible ; un déplacement entre projets exige les droits des deux côtés.

Les rôles ne changent pas : pas de rôle supplémentaire. La gestion des personnes,
participants, paramètres serveur et connaissances reste administrative. Les
participants peuvent consulter les connaissances et gérer les contenus manuels.
La création d'un projet inscrit son créateur parmi les participants. L'exécution
Codex, le terminal, les automatismes et la planification IA restent réservés aux
administrateurs, y compris les appels indirects du chat simple avec backend Codex.

Le chef de projet et les groupes configurés dans un projet sont des informations
d’organisation. Ils n’accordent aucun privilège et ne réduisent pas le périmètre
des participants. Leur fonctionnement est détaillé dans
[Organisation des personnes](organisation-personnes-projets.md).

## Conversations historiques

La migration `0033_project_authorization` ajoute une table de propriétaires et une
table de sessions documentaires révocables, sans effacer les données existantes.
Les associations explicites à un projet sont conservées. Les nouvelles
conversations enregistrent leur créateur. Une conversation sans projet et sans
propriétaire certain reste accessible aux administrateurs uniquement : aucun
créateur n'est deviné à partir du dossier de travail. Les anciennes associations
ne sont plus automatiquement déduites du `cwd` lors du chargement des projets.
Un administrateur peut rattacher une conversation historique au projet voulu.

## Fichiers et sessions ouvertes

Les chemins sont résolus physiquement et soumis aux droits du projet propriétaire.
Les nouveaux workspaces secondaires ne peuvent pas chevaucher un workspace
existant. Une ambiguïté historique entre projets est refusée aux utilisateurs
standards ; un administrateur doit réorganiser ces rattachements.

Les abonnements Socket.IO sont autorisés par conversation. Les permissions sont
revérifiées à la livraison des événements. Les approbations et événements globaux
contenant des données d'exécution sont réservés aux administrateurs.

Le retrait d'un participant révoque ses sessions documentaires et déconnecte ses
sockets. Le navigateur abandonne ses caches et recharge la plateforme. Les
nouvelles lectures et sauvegardes sont alors refusées. Les données déjà
téléchargées ou copiées ne peuvent pas être récupérées à distance.

Les URLs OnlyOffice de lecture et sauvegarde portent une session limitée au
document et au mode demandé. Le callback vérifie la session, les signatures et le
chemin avant d'écrire. Une session révoquée ne redevient pas valide après une
réinscription au projet. Les anciens éditeurs OnlyOffice devront être rouverts
après déploiement, car leurs anciens jetons ne suffisent plus.

Le backend et sa clé de service doivent rester privés derrière l’ingress configuré
avec une authentification (sessions natives ou contrôle Authentik),
qui remplace les en-têtes d'identité. Le mode de service conserve son accès
administrateur pour les opérations internes et les contrôles de santé.

## Validation

Les tests `project-authorization.spec.ts` utilisent les vrais contrôleurs HTTP,
services et migrations SQLite avec deux projets distincts, un administrateur, deux
participants et un compte sans projet. Ils couvrent les listes, les écritures,
les chemins, les symlinks, les conversations historiques, les appels indirects et
la révocation des capacités documentaires. `project-socket-authorization.spec.ts`
vérifie les vrais échanges Socket.IO et les connexions déjà ouvertes.
