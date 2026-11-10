# Centre de notifications

La cloche, à gauche du compte, ouvre un panneau global à droite. L’en-tête (fermeture, filtres, regroupement et « tout marquer comme lu ») ne défile pas : seule la liste défile, indépendamment de la conversation. Le panneau reste ouvert au changement d’agent. Sur mobile, il utilise la largeur disponible sans débordement horizontal.

Les événements signalés sont les échecs d’agents, les demandes d’approbation, les questions nécessitant une réponse et les erreurs affichées dans les conversations et les notifications rouges de l’interface. Les erreurs de l’interface sont personnelles ; les événements d’agents sont distribués aux personnes ayant accès au projet et à la conversation au moment de l’événement. Les fins de travail réussies ne créent pas de notification dans ce centre ; les anciennes notifications de ce type sont également exclues de la liste et du compteur non lu. L’historique est indépendant des abonnements Web Push.

La liste et les groupes de projets suivent l’ordre du plus récent au plus ancien. Les filtres Toutes, Non lues et Lues portent sur la liste. La cloche affiche le total non lu accessible, indépendamment du filtre. Le regroupement utilise l’identifiant du projet : deux projets portant le même nom restent distincts. Les listes sont paginées par 100 notifications avec un bouton pour charger les plus anciennes.

Cliquer sur une notification la marque comme lue puis ouvre son agent ou son projet ; l’enveloppe permet aussi de la marquer comme lue/non lue sans naviguer. Lire ne répond pas aux questions et n’autorise jamais une action. Une ancienne demande peut avoir déjà été traitée dans sa conversation.

## Droits et conservation

Chaque notification appartient à une personne. Le serveur revérifie l’accès au projet et à l’agent lors de chaque lecture ou mutation, compteurs compris. Aucun identifiant de destinataire n’est accepté du navigateur. Un retrait d’accès masque aussi les anciens événements ; un lien est revérifié avant navigation. Les données du panneau sont actualisées toutes les dix secondes et au retour sur la fenêtre. Un changement de personne ferme le panneau et purge son cache. Le centre personnel n’est pas disponible sous usurpation d’identité.

Dans le profil, la conservation est réglable de 1 à 365 jours, avec 7 jours par défaut. Les notifications expirées ne sont jamais retournées par l’API ; un nettoyage au démarrage et toutes les heures les supprime physiquement. Réduire la durée applique le nettoyage immédiatement. Seul l’historique des notifications est supprimé, jamais les conversations, documents ou demandes en attente.

## Technique

Le module `NotificationsModule` écoute `turn/completed` du gestionnaire Codex et le flux des demandes persistantes. Les événements sont dédupliqués par personne et clé d’événement. Les erreurs répétées de l’interface sont regroupées par personne, cible et message dans une fenêtre de cinq minutes. Les événements éphémères ne sont pas conservés. Les nouvelles sources d’événements doivent utiliser les mêmes vérifications et ne doivent pas enregistrer le contenu des conversations ou des secrets.

La migration `0077_notification_center` ajoute `inbox_notifications` et `inbox_preferences`. Le panneau est monté dans `AuthenticatedLayout`, hors de la route d’un agent, et utilise un état global d’ouverture. Le cache React Query est séparé par personne et filtre. Le scroll est porté par un enfant `min-h-0 flex-1 overflow-y-auto overscroll-contain` d’un panneau contraint à la hauteur visible ; l’en-tête est `shrink-0`.

API authentifiée :

- `GET /api/notifications?filter=all|read|unread&cursor=<id>` : liste, compteur non lu et curseur suivant.
- `PATCH /api/notifications/:id/read` avec `{ "read": true|false }` : état individuel ; `all` vise uniquement les notifications encore accessibles.
- `GET /api/notifications/preferences` : durée personnelle de conservation.
- `PATCH /api/notifications/preferences` avec `{ "retentionDays": 7 }` : validation entière entre 1 et 365.
- `POST /api/notifications/errors` avec `{ "message": "…", "projectId"?: "…", "threadId"?: "…" }` : erreur personnelle, message limité à 1 000 caractères et cibles revérifiées. Ne pas envoyer de secret.

Les contrôles automatiques couvrent les droits après révocation, les accès croisés entre personnes, les compteurs, la déduplication, la pagination, l’expiration, la navigation et le scroll en Chromium et WebKit sur mobile et ordinateur.
