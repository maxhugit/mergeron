# Dernières évolutions de Mergeron

[← Sommaire de la documentation](README.md)

État vérifié le **10 novembre 2026**, sur les changements fusionnés jusqu’à la
[PR #472](https://github.com/maxhugit/mergeron/pull/472), après la #473.
Ces corrections sont postérieures au tag **v0.7.5** : elles ne sont pas ajoutées
rétroactivement à ses notes. Leur disponibilité dépend de l’image réellement
installée, consultable dans **Serveur → Version actuelle**.

## Conversations : la suite reste sous votre intervention

Quand vous ajoutez une précision pendant la rédaction de l’agent, la réponse
se lit maintenant dans cet ordre : début de réponse, votre précision, puis
continuation. Après une question ou une sollicitation MCP, la carte reste à sa
place et la suite apparaît en dessous. Cela fonctionne aussi si le serveur
continue le même message natif.

Les limites observées restent stables après reconnexion et changement d’agent.
Une relance refusée est retirée et les fragments se rejoignent. Un rechargement
utilise les positions natives disponibles ; l’ordre exact d’une ancienne question
sans outil dans l’historique et jamais reçue par ce navigateur ne peut pas être
reconstruit. Les permissions et l’exécution de l’agent ne sont pas modifiées.

Référence : [récupération et fragments de conversation](conversation-recovery.md#human-interventions-inside-an-assistant-turn).
Correction : [#472](https://github.com/maxhugit/mergeron/pull/472).

## Livrables : synchronisation Git par document

Un document en conflit ne bloque plus les autres exports vérifiés. Le badge de
version est **orange** pour une opération ou une revue en attente, **rouge** pour
un conflit ou une erreur bloquante. Cliquez sur ce badge pour comparer le document
et proposer une correction, puis confirmez le choix examiné.

Le serveur revérifie la copie, la branche, les droits et le contenu. Importer crée
une nouvelle version Mergeron ; remplacer le fichier Git conserve les octets
précédents en récupération privée. Les documents voisins ne sont pas forcés.
La synchronisation se gère dans **Livrables**, sans panneau redondant dans Sources.
Une synchronisation locale ne crée ni commit ni push.

Référence : [livrables Git](livrables-git.md).
Corrections : [#466](https://github.com/maxhugit/mergeron/pull/466),
[#470](https://github.com/maxhugit/mergeron/pull/470).

## Maquettes : une archive et un aperçu versionné

La publication d’une maquette dans un livrable produit toujours un ZIP, même
pour un seul HTML. Son manifeste permet de reconnaître la maquette et de rouvrir
l’aperçu de la version publiée. Le code source et les fichiers de l’archive
restent inspectables ; les anciens exports HTML restent lisibles.

Les ressources doivent actuellement être intégrées au HTML autonome. L’archive
ne collecte pas automatiquement les fichiers JS et images voisins. L’aperçu
reste isolé : aucun accès à Mergeron ni chargement de ressources externes.

Référence : [maquettes interactives](interactive-mockups.md).
Correction : [#467](https://github.com/maxhugit/mergeron/pull/467).

## Environnements de test : expliquer les prérequis manquants

Les paramètres du projet et l’onglet de test affichent les prérequis qui empêchent
le démarrage : activation globale, Manager, domaine d’aperçu, accès de consultation,
recette et runtimes autorisés. L’autorisation du projet seule ne configure pas
ces services. Une lecture de prérequis en échec ne débloque pas le démarrage.

Référence : [procédure de mise en service, prérequis et diagnostic](previsualisations-agents.md#procédure-de-mise-en-service--du-serveur-au-premier-aperçu).
Correction : [#471](https://github.com/maxhugit/mergeron/pull/471).

## Notifications : priorité aux interventions utiles

Le centre personnel affiche les échecs, les questions, les approbations et les
erreurs de l’interface. Les fins de travail réussies sont exclues de la liste et
du compteur non lu, y compris les anciennes notifications de ce type. Les Web
Push par appareil restent un mécanisme distinct.

Le panneau utilise la hauteur disponible depuis le haut de la fenêtre. Son
en-tête reste fixe, la liste défile indépendamment et le panneau reste ouvert
lors d’un changement d’agent. Les filtres, droits d’accès et durées de conservation
personnelles restent applicables.

Référence : [centre de notifications](notifications.md).
Corrections : [#469](https://github.com/maxhugit/mergeron/pull/469),
[#473](https://github.com/maxhugit/mergeron/pull/473).

## Guide intégré et versions publiées

Les mêmes parcours sont documentés en français et en anglais dans **Documentation
de Mergeron** (`/help`). La frise [Historique des versions](historique-des-versions.md)
continue à présenter uniquement les tags publiés ; cette page rassemble les
changements fusionnés après le dernier tag et ne constitue pas un état de déploiement.
