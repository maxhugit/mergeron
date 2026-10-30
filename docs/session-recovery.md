# Connexion après une longue inactivité

## Diagnostic du 25 octobre 2026 — environnement development

L’écran « Accès indisponible / Impossible de vérifier votre identité » ne prouve
pas à lui seul que le compte a été désactivé : l’ancienne interface affichait le
même écran pour une erreur réseau et pour un refus d’accès. Elle affichait aussi
l’adresse et la référence d’une identité conservée en cache après une erreur.

L’analyse a porté sur les journaux de l’application, de Nginx et d’Authentik,
la configuration réellement chargée des deux proxys, la version du conteneur et
un comptage des personnes actives dans la base ouverte en lecture seule. Aucun
cookie, jeton, mot de passe ou identifiant personnel n’est reproduit ici.

Constats :

- Le compte de la dev est actif et associé au SSO. L’authentification native
  Mergeron n’est pas configurée sur cette instance : l’accès repose sur le proxy
  Authentik.
- Dans la collecte initiale (24 heures, au maximum 30 000 lignes par conteneur),
  les 16 requêtes `/api/auth/me` arrivées à l’application ont répondu `200`.
  Cela ne prouve pas que les autres requêtes ont réussi : le proxy peut les
  intercepter avant l’application.
- Authentik a enregistré des redirections `302` sur son point de contrôle
  Traefik, notamment à 06:19–06:22 UTC. Les premières vérifications d’identité
  réussies du matin apparaissent à 06:22:49 UTC dans Nginx. Le 25 octobre 2026,
  07:20 à Paris correspond à 06:20 UTC. Cette proximité est compatible avec la
  capture fournie ; elle ne permet pas d’attribuer chaque requête à cet iPhone.
- La route Traefik de la dev utilisait encore le middleware Authentik alors que
  Nginx effectuait déjà le même contrôle. Une requête anonyme publique partait
  directement vers `/application/o/authorize/`, alors que la même requête vers
  Nginx partait vers `/outpost.goauthentik.io/start`.
- L’ancien client suivait automatiquement ces redirections dans `fetch`. Une
  navigation SSO n’est pas une réponse JSON d’identité ; elle peut devenir une
  erreur réseau/CORS ou une erreur de lecture JSON, sans refus dans les logs de
  l’application.
- Après épuisement des tentatives, l’interface démontait l’espace de travail et
  ses écouteurs de récupération réseau. Les requêtes d’identité n’avaient pas
  non plus de délai maximal.
- La version exécutée pendant le diagnostic était `21446d2`, construite le
  24 octobre à 16:32 UTC. Une PR fusionnée n’est donc pas la preuve que son image
  tourne déjà dans l’environnement.

Il n’est pas possible de prouver depuis les seuls logs serveur l’état exact des
connexions internes de Safari pendant sa suspension. Le défaut client est en
revanche reproductible avec une identité en cache suivie d’une erreur HTTP ou
d’une redirection de connexion.

## Corrections

Le client ne suit plus les redirections de vérification d’identité dans `fetch`.
Depuis le correctif de reprise sans rechargement, une redirection de proxy ne
provoque plus de navigation de l’onglet de travail. La reprise réseau est essayée
en JavaScript. Si l’authentification est vraiment expirée, le bouton **Rétablir
la connexion** ouvre une fenêtre sur une URL locale fixe de connexion. Le proxy
ou le fournisseur OIDC peut y effectuer ses redirections normalement ; aucune
destination fournie par un `fetch` n’est utilisée pour naviguer l’onglet principal.

L’espace de travail déjà vérifié est conservé dans une frontière React `Activity`
masquée : état React et DOM conservés, effets et abonnements nettoyés pendant
l’attente. La fenêtre d’attente n’est pas fermable par Échap ou un clic extérieur.
Le suivi de mise à jour du Manager reste disponible pendant une interruption.
Cela ne garantit pas la conservation après fermeture, rechargement volontaire
ou suppression de l’onglet par le navigateur ; les lecteurs externes peuvent
aussi devoir reconstruire leur propre session à la reprise.

`session-recovery.ts`, installé avant le rendu, ferme immédiatement une barrière
locale au retour après 30 secondes sans vérification ou après un refus de session.
Les requêtes API protégées sont rejetées avec `AbortError`, jamais mises en file ;
les réponses antérieures à la fermeture sont écartées. Seuls les points de
connexion et la vérification d’identité restent utilisables. Le socket est
déconnecté et sa file d’envois est vidée avant reprise. Les contrôles serveur
restent obligatoires : cette barrière n’est pas une autorisation de sécurité.

La fenêtre de connexion signale sa réussite à la seule origine Mergeron. Le
parent valide origine, référence de fenêtre et type de message avant d’accepter
un éventuel JWT de connexion API ; le message ne donne jamais accès. Une nouvelle
lecture `/api/auth/me` doit confirmer le même compte, rôle et contexte de test
de droits. Si ceux-ci changent, l’ancien onglet reste verrouillé : un nouvel
onglet doit être utilisé pour les nouveaux droits. Une fenêtre bloquée est
signalée ; aucune navigation de remplacement n’est imposée. Un contrôle toutes
les cinq secondes, limité à deux minutes et aux onglets visibles/en ligne,
couvre aussi les cookies partagés lorsque le fournisseur coupe `window.opener`.
Les changements explicites d’identité et les révocations de droits conservent
leur politique distincte de purge des vues ; ce correctif ne les contourne pas.

La vérification et la lecture de son corps disposent d’un délai de 12 secondes.
L’annulation par le gestionnaire de requêtes est propagée. Les reprises sur
`pageshow`, retour en ligne, retour au premier plan et changement de visibilité
restent actives même si l’espace de travail est masqué après une erreur. Les
événements rapprochés sont regroupés et les requêtes déjà en cours sont conservées.

Une erreur de transport, un renouvellement SSO et un vrai refus d’accès sont
présentés séparément, en français et en anglais. Une identité active en cache ne
permet **pas** de contourner une vérification échouée. Les refus `401`/`403` ne
sont pas réessayés comme des erreurs transitoires. Aucune écriture ni aucun
message n’est rejoué automatiquement.

La route Traefik **development uniquement** a été corrigée le 25 octobre à
06:49:49 UTC pour supprimer le contrôle redondant, conformément au modèle du
dépôt. Le contrôle Nginx et les en-têtes d’identité imposés côté serveur ont été
vérifiés avant modification. Une sauvegarde a été conservée hors du répertoire
de configuration surveillé, et le contrôle anonyme après modification a toujours
renvoyé `302`, cette fois vers `/outpost.goauthentik.io/start`. La production,
les comptes et les données de l’application n’ont pas été modifiés.

## Vérification d’une installation

### Redirection vers le port interne

Un contrôle HTTP ultérieur a révélé un défaut distinct : le `return 302` relatif
du point de connexion était transformé par Nginx en URL absolue HTTP avec son
port d’écoute interne `8080`. HSTS pouvait ensuite transformer le schéma en
HTTPS sans retirer ce port. Ce n’était pas une erreur DNS ou une URL de retour
configurée dans le compte utilisateur.

Les deux modèles ingress fixent désormais `absolute_redirect off` dans leur
bloc `server`. Cela garde les redirections locales relatives et conserve le
schéma, l’hôte et le port public du navigateur, quel que soit le proxy externe.
Les URL absolues renvoyées par un fournisseur d’identité ne sont pas réécrites.
Voir la [directive officielle Nginx](https://nginx.org/en/docs/http/ngx_http_core_module.html#absolute_redirect).

Pour une installation existante, sauvegarder le modèle privé, ajouter la
directive dans son bloc `server`, régénérer la configuration avec la méthode
habituelle (sans afficher le jeton), valider le même fichier avec `nginx -t -c`
et effectuer un rechargement gracieux. Un simple `nginx -s reload` ne régénère
pas un modèle envsubst. Ne pas remplacer tout le fichier par un modèle du dépôt :
il peut contenir des noms d’upstream propres à la pile.

En development, la correction a été appliquée le 25 octobre à 09:19 UTC, après
sauvegarde du modèle privé et test de syntaxe. `/` et `/api/auth/me` ont conservé
leur refus anonyme `302`, avec un `Location` relatif sans `8080`. La chaîne de
connexion a ensuite atteint la page du fournisseur en `200`, et le contrôle de
santé interne est resté en `200`. Seul l’ingress development a été rechargé ;
production, données et politique d’authentification n’ont pas été modifiées.

### Contrôles du parcours complet

Avec le mode proxy Authentik de ce dépôt, Nginx est le point de contrôle unique.
Ne pas réintroduire un middleware d’authentification sur la route Traefik du
navigateur ou sur les routes `/outpost.goauthentik.io` : le parcours de connexion
doit pouvoir atteindre l’outpost. Ne jamais retirer le contrôle Nginx pour
« résoudre » une reconnexion.

1. Vérifier les directives du fichier **réellement chargé** par Nginx. Un
   `nginx -T` sans le même argument `-c` que le processus actif peut afficher
   une autre configuration.
2. Sans cookie, `/` et `/api/auth/me` doivent déclencher l’authentification,
   jamais retourner une identité active ni du contenu protégé.
3. Avec une session valide, `/api/auth/me` doit retourner une identité JSON
   active et l’interface doit s’ouvrir.
4. Laisser l’onglet en arrière-plan, révoquer ou expirer sa session SSO de test,
   puis revenir : le navigateur doit garder le brouillon non envoyé et l’URL,
   masquer le contenu protégé, puis reprendre après vérification ou proposer
   une connexion séparée. Aucun rechargement de l’onglet principal n’est attendu.
5. Tester séparément une coupure réseau puis un retour en ligne, un retour via
   l’historique du navigateur et un compte réellement désactivé.
6. Pour un compte désactivé ou un refus d’accès réel, l’espace de travail doit
   rester inaccessible.
7. Bloquer les popups, annuler une connexion et essayer un autre compte : aucun
   cas ne doit restaurer une ancienne identité depuis le cache ni rejouer une
   écriture. Un message venant d’une autre origine ou fenêtre doit être ignoré.

Les tests automatisés simulent redirections, transport interrompu, temporisation,
annulation et reprise avec une identité en cache. Un essai long sur l’iPhone réel
reste nécessaire après publication et déploiement de l’image corrigée ; les tests
de navigateur ne simulent pas une suspension iOS de plusieurs heures.

Références : [mode de redirection de fetch](https://developer.mozilla.org/en-US/docs/Web/API/Request/redirect),
[conservation d’état avec Activity](https://react.dev/reference/react/Activity)
et [intégration proxy Traefik Authentik](https://docs.goauthentik.io/add-secure-apps/providers/proxy/server_traefik/).
