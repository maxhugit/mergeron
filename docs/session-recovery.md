# Connexion après une longue inactivité

## Diagnostic local des interruptions

Le **Diagnostic de connexion** est disponible dans l’écran de vérification ou
de reprise, puis dans la page **Journaux** après reconnexion. Il conserve au
maximum 100 événements en mémoire dans l’onglet courant et regroupe les
répétitions immédiates. Recharger ou fermer l’onglet efface cet historique ;
il ne permet pas d’analyser rétroactivement un autre appareil ou un incident
antérieur à son installation.

La chronologie indique les déclencheurs de vérification (retour à la fenêtre,
réseau, vérification périodique), les pauses/reprises, les nouvelles tentatives,
les réponses obsolètes écartées et les refus locaux de requêtes. Elle distingue
redirection de connexion, refus HTTP, indisponibilité HTTP, problème de transport,
délai dépassé, réponse inattendue et changement d’identité ou de droits. Les
durées, générations et numéros de tentative aident à comprendre l’ordre des
événements. Une redirection n’est pas une preuve d’expiration ; un `502` ou un
`503` ne prouve pas quel composant est en panne. Un signal « en ligne » du
navigateur ne prouve pas que le serveur est joignable. Une nouvelle vérification
déclenchée par un retour à la fenêtre se distingue des trois tentatives bornées
d’une même vérification.

**Télécharger le diagnostic** produit un JSON local à transmettre manuellement
si nécessaire. Il ne contient ni identité, compte, email, cookie, jeton, URL,
en-tête, message d’erreur brut ni saisie/conversation. Seuls des codes fermés et
des valeurs numériques bornées sont enregistrés. Le nom de l’asset d’entrée
public peut identifier le client chargé, sans son domaine ni ses paramètres.
Aucun événement n’est téléversé automatiquement ni écrit dans le stockage
persistant du navigateur ou les journaux serveur. Effacer ou consulter ce
diagnostic ne change jamais l’état d’autorisation ni les tentatives de reprise.

### Vérifications de panne isolées

Les scénarios Chromium et WebKit de
`web/src/routes/authenticated-layout.browser.tsx` utilisent le vrai layout et
le vrai mécanisme de session avec trois services HTTP de test en boucle locale.
Ils ferment puis rouvrent réellement les écouteurs du backend synthétique, du
fournisseur d’identité synthétique ou du proxy de test. Ils vérifient la reprise
automatique après une nouvelle réponse d’identité, la conservation du même
brouillon et du défilement, le blocage des écritures sans mise en attente, les
refus persistants et l’absence d’identité/contenu dans l’export. Chaque fixture
confirme la fermeture de ses propres écouteurs après le test. Les commandes et
routes de cette fixture n’existent que dans la configuration Vitest, pas dans
l’application publiée.

En complément, `scripts/test-session-ingress.py`, exécuté par le smoke test
ingress de la CI, lance trois processus Nginx indépendants dans un conteneur
jetable. Le frontal utilise le vrai modèle ingress ; les deux upstreams sont
synthétiques. Le contrôle arrête puis relance chaque processus et vérifie les
refus, le retour d’accès après contrôle frais, les cookies et la déconnexion.
Le conteneur n’a ni réseau externe, port publié, montage hôte, socket Docker ni
secret réel ; il est non privilégié, non-root, à racine en lecture seule et
avec ressources bornées. Seule sa propre ressource Docker est retirée.

Ces deux niveaux ne constituent pas un arrêt/redémarrage de la Dev ou d’Authentik
et PostgreSQL réels. Après déploiement autorisé, une observation prolongée des
retours de veille, changements d’onglet et interruptions réelles reste nécessaire
pour conclure sur l’incident intermittent de l’installation.

## Vérification ordinaire et renouvellement interactif

Un clic dans un champ de saisie n’est pas un retour à la fenêtre. L’écoute de
`focus` en phase de capture sur `window` voit aussi le focus de ses descendants :
le client doit ignorer ces événements avant d’appliquer le seuil de fraîcheur de
30 secondes. L’ancienne règle pouvait donc suspendre la session pendant une
interaction normale, sans refus du serveur. Un test de régression reproduit un
focus dans un champ après 31 secondes ; il échoue sans cette distinction.

Les consommateurs de l’identité partagent un seul coordinateur par client de
requêtes : une vérification périodique, un mécanisme de reprise et un ensemble
d’écouteurs. Les événements rapprochés `focus`, `pageshow`, `online` et
`visibilitychange` partagent la même sonde. Une génération nouvellement fermée
déclenche une lecture fraîche immédiatement : le délai anti-répétition ne doit
pas retenir cette lecture derrière une ancienne sonde, dont la réponse ne peut
plus autoriser la génération courante. Seules les lectures d’identité dépassées
sont annulées ; aucune action ni saisie n’est rejouée.

Pendant une vérification ordinaire, le client présente un état non modal
« Vérification de l’identité… », pas « Session à renouveler ». L’espace de travail
reste conservé mais masqué, les requêtes protégées et le socket restent bloqués.
Une réponse fraîche pour la même identité et les mêmes droits est toujours
nécessaire pour reprendre. Un refus persistant, une panne de connexion et un
changement d’identité gardent leurs états distincts et bloquants ; la fenêtre de
connexion ne s’ouvre jamais automatiquement. Les vrais refus `401`/`403` et les
changements de droits ne sont pas réessayés par le polling de panne serveur.

Les tests unitaires et les scénarios Chromium/WebKit couvrent ces événements,
la conservation du brouillon et du défilement, les réponses anciennes, l’absence
de rejeu, le démontage des consommateurs et l’affichage ordinateur/mobile. Ils
utilisent des identités synthétiques et ne remplacent pas l’observation prolongée
de l’installation après son déploiement.

## Incidents intermittents en Dev — diagnostic du 31 octobre 2026

La durée du fournisseur Authentik Dev a été relue : `hours=12`, avec une
durée effective de cookie de 43 201 secondes pour une nouvelle session proxy.
La configuration Nginx réellement chargée (`/tmp/nginx.conf`, et non le fichier
par défaut de l'image) conserve le contrôle Authentik unique et les redirections
relatives. Allonger encore la durée ne corrige donc pas les interruptions.

Les journaux consultés montrent plusieurs événements distincts :

- des redirections de `/api/auth/me` vers la connexion ;
- des erreurs `500` du contrôle Authentik au moment du redémarrage de ce service ;
- des redémarrages de plusieurs services de l'hôte pendant la même période.

L'interface a également été observée passant de « Session à renouveler » à la
conversation connectée sans nouvelle authentification effectuée par le diagnostic.
Ces éléments ne prouvent pas que chaque incident signalé a la même cause. Les
journaux conservés ne permettent notamment pas de reconstituer tous les cookies
ou toutes les sessions avant les redémarrages ; ils ne doivent pas être collectés
pour ce diagnostic.

Deux défauts reproductibles sont corrigés :

1. Le modèle Nginx retransmettait les `Set-Cookie` d'un contrôle d'authentification
   refusé. Dans Authentik 2026.5.7, `getClaimsFromSession` tente de supprimer le
   cookie lorsque la lecture du stockage de sessions renvoie une erreur, pas
   seulement à l'expiration. Selon l'erreur et l'état du stockage, cela peut
   transformer une interruption en perte du cookie navigateur. Le modèle ne
   transmet désormais le cookie de renouvellement du sous-appel que si ce
   dernier réussit en `2xx`. **Un cookie conservé n'autorise rien** : chaque
   nouvelle requête protégée doit toujours être acceptée par Authentik. Les
   réponses des vraies routes de connexion et de déconnexion restent inchangées.
   Une session réellement supprimée du stockage ne peut pas être restaurée par
   ce correctif et nécessite toujours une nouvelle connexion.
2. Une ancienne réponse API `401` ou redirigée, arrivée après la reprise, pouvait
   refermer la barrière et effacer le nouveau jeton. Les réponses d'une génération
   antérieure sont maintenant écartées **avant** de traiter leur refus. Inversement,
   une réponse d'identité demandée avant la fermeture ne peut pas rouvrir la
   barrière : une nouvelle vérification est obligatoire.

Pour un onglet ayant déjà vérifié son identité, une redirection du proxy déclenche
au maximum trois nouvelles lectures d'identité, après 500, 1 500 et 3 000 ms.
La barrière reste fermée et la vue indique la vérification pendant cet essai.
Seule une réponse fraîche confirmant le même compte, rôle et contexte de test
de droits permet la reprise. Si le refus persiste, le renouvellement interactif
reste nécessaire. Les vrais `401`/`403` du backend ne deviennent pas des erreurs
transitoires. Les requêtes d'identité utilisent explicitement `cache: no-store`.
Aucune mutation ni aucun message n'est mis en attente ou rejoué.

Références du comportement amont vérifié :
[lecture des claims Authentik 2026.5.7](https://github.com/goauthentik/authentik/blob/version/2026.5.7/internal/outpost/proxyv2/application/auth.go),
[stockage PostgreSQL](https://github.com/goauthentik/authentik/blob/version/2026.5.7/internal/outpost/proxyv2/postgresstore/postgresstore.go).

### Vérifier et installer ce correctif

`python3 scripts/test-session-ingress.py` exerce le vrai modèle dans un conteneur
Nginx jetable, sans réseau, port publié, volume hôte ni donnée réelle. Un faux
outpost simule les refus `401`/`403` et une indisponibilité `503`, avec suppression
de cookie. Le test vérifie le refus d'accès, la conservation du cookie, une
nouvelle autorisation après rétablissement et la déconnexion explicite. Il est
inclus dans `scripts/smoke-test-ingress.sh` exécuté en CI. Cette simulation ne
redémarre pas Authentik et ne prétend pas reproduire chaque panne de sa base.

Les tests du client couvrent les redirections réelles du navigateur, la reprise
bornée, l'expiration persistante, un changement d'identité, les réponses obsolètes,
les écritures bloquées ainsi que la conservation du brouillon et de la lecture
dans Chromium et WebKit. Ils ne remplacent pas une observation prolongée de
l'installation réelle.

Une mise à jour de l'application seule **ne suffit pas** pour une installation
qui conserve un modèle ingress privé. Reporter la nouvelle `map`,
`auth_request_set $auth_status`, le filtrage du `Set-Cookie` et le `no-store` de
la redirection dans ce modèle, sans écraser ses upstreams, domaines ou secrets.
Régénérer le fichier avec l'allowlist habituelle d'`envsubst`, valider exactement
ce fichier avec `nginx -t -c`, puis recharger gracieusement le seul ingress visé.
Conserver un exemplaire de retour arrière hors du dossier surveillé. Vérifier
ensuite le refus anonyme et le parcours connecté. La durée SSO, les révocations,
les secrets et la politique d'accès ne sont pas modifiés par ce correctif.

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
l’attente. La vérification ordinaire utilise un état non modal ; les fenêtres
de refus ou d’erreur persistante ne sont pas fermables par Échap ou un clic extérieur.
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
permet **pas** de contourner une vérification échouée. Les refus `401`/`403` du
backend ne sont pas réessayés comme des erreurs transitoires ; les redirections
du proxy bénéficient seulement de la reprise bornée décrite plus haut. Aucune écriture ni aucun
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
