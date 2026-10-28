# Navigateur annoté dans une conversation

L’icône **Navigateur**, à gauche de l’explorateur, ouvre un onglet à côté de
Conversation, avec une vue côte à côte optionnelle sur ordinateur.
Créez un onglet, saisissez une URL puis choisissez **Pointer un élément**.
Cliquez dans l’image de la page, rédigez votre consigne et choisissez
**Ajouter au brouillon du chat**. Le message existant est conservé. L’annotation
ajoute l’URL, la date, le sélecteur, le texte et la géométrie de l’élément ainsi
qu’une capture avec un repère numéroté. Vérifiez le brouillon avant de l’envoyer.
Le pointage ne clique pas sur l’élément distant et ne déclenche pas d’agent.

## Choix technique

| Solution                                      | Limite                                                                                                                      | Décision    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------- |
| iframe vers le site                           | X-Frame-Options/CSP peuvent interdire l’affichage ; même sans cela, la politique de même origine interdit l’inspection HTML | Non retenue |
| Réécriture/proxy HTML dans l’origine Mergeron | Fragile pour JavaScript, cookies, liens, CSP et authentification ; risque de mélanger les privilèges                        | Non retenue |
| Chromium distant isolé, piloté par Playwright | Nécessite un service supplémentaire ; affichage par captures plutôt qu’une surface native                                   | Retenue     |

Les pages sont chargées comme documents de premier niveau dans Chromium.
Mergeron ne supprime aucun en-tête de sécurité et ne reçoit jamais leur HTML
exécutable. Seuls les pixels et les métadonnées bornées de l’élément sélectionné
rejoignent l’interface. Les données de page sont marquées comme preuve non fiable,
distincte de la consigne saisie par l’utilisateur.

Sources : [politique de même origine](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy),
[X-Frame-Options](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options),
[connexion distante Playwright](https://playwright.dev/docs/docker#remote-connection).

## Sessions et limites

- Réservé aux administrateurs, comme l’exécution serveur existante. Chaque requête
  vérifie également le droit d’accès à la conversation. Une identité simulée non
  administratrice n’accède pas au navigateur.
- Un contexte séparé par personne, session d’usurpation et conversation. Les
  onglets d’une conversation partagent leurs cookies, jamais ceux d’une autre.
- Session distante en mémoire : aucune reprise des cookies du navigateur de
  l’utilisateur, ni des comptes Codex, ni des secrets de Mergeron. Une connexion
  à un site doit être faite dans ce navigateur distant.
- Cinq onglets par session, huit sessions serveur, expiration après quinze minutes
  sans commande. **Effacer la session** ferme les pages et détruit les cookies.
  Fermer le panneau seul conserve temporairement ses onglets. Un redémarrage
  serveur perd ces sessions.
- Navigation au clic, historique, rechargement, défilement et saisie dans le champ
  ciblé. Hors pointage, la souris et le clavier agissent directement dans le
  [flux continu](live-browser.md). Les captures de pointage ne comportent plus de
  cache rose sur les champs : vérifiez leur contenu avant d’envoyer le brouillon.
  Aucun stockage des valeurs saisies dans Mergeron.
- Les images sont actualisées après les commandes ou sur demande, pas en vidéo.
  Une page ayant changé entre l’image et le pointage impose une actualisation.
- Les cadres intégrés sont identifiés comme cadres ; cette version ne sélectionne
  pas leurs éléments internes. Les shadow roots ouverts sont traversés ; les
  shadow roots fermés restent opaques. Le sélecteur est indicatif et non une
  garantie de stabilité après modification de la page.
- Téléchargements, fenêtres surgissantes, permissions sensibles et WebSockets
  sont bloqués. Les sites exigeant ces fonctions peuvent être incomplets.
- Le proxy autorise uniquement HTTP public sur 80 et HTTPS public sur 443, en IPv4.
  Réseaux privés, loopback, métadonnées cloud, adresses réservées et IPv6 sont
  refusés, y compris dans les sous-requêtes et les redirections. Le DNS est résolu
  puis l’adresse validée est utilisée directement pour la connexion, sans seconde
  résolution susceptible de permettre un rebinding. Pas d’exception LAN implicite.

## Installation optionnelle

Le navigateur n’est **pas** exécuté dans le conteneur applicatif : il n’y a aucun
montage de données, secret, socket Docker, port hôte, mode privilégié ou capacité
Linux supplémentaire. L’application et le navigateur partagent seulement un
réseau de contrôle interne. Le navigateur possède son propre réseau de sortie.
Chromium utilise son sandbox, un utilisateur non root et le profil seccomp déjà
fourni. Un hôte incompatible doit faire échouer le démarrage : ne pas ajouter
`--no-sandbox` ou `--privileged` pour contourner le problème.

1. Définissez `BROWSER_WS_PATH` dans l’environnement de Compose avec au moins
   32 caractères aléatoires. Ne le publiez pas : ce chemin protège le canal de
   contrôle Playwright. Le service n’expose aucun port sur l’hôte.
2. Ajoutez `deployment/compose.browser.yml` au déploiement :

   ```sh
   docker compose --env-file deployment/.env -f deployment/compose.yml -f deployment/compose.browser.yml up -d --build
   ```

3. L’overlay définit `MERGERON_BROWSER_ENDPOINT` uniquement dans l’application.
   Les deux côtés utilisent Playwright 1.64.1 ; leurs versions doivent correspondre.
   Sans endpoint, l’interface affiche une indisponibilité, sans lancer de navigateur
   dans l’application ni retomber sur un iframe.

Ce service reste optionnel. En production, il conserve un cycle de déploiement
séparé : la gestion décrite ci-dessous est activable uniquement en DEV.

## Gestion par le Manager en DEV

Sur une pile dédiée `mergeron-dev`, après installation et vérification du
navigateur isolé, exécuter `scripts/configure-dev-browser.py --confirm-configure`
sur l’hôte Docker. Cet outil vérifie l’identité et les protections du conteneur
existant, le recrée avec ses mêmes secrets, image et réseaux, ajoute les labels
de gestion et définit **uniquement pour lui** `HostConfig.Dns = ["1.1.1.1"]`.
Il conserve le conteneur précédent pour retour arrière et ne modifie ni le DNS
de l’hôte, ni les autres conteneurs. Les sessions temporaires sont perdues.

Mettre ensuite à jour le Manager DEV avec
`scripts/update-dev-manager.py REVISION --confirm-replace --manage-browser`.
L’option persistante `MERGERON_MANAGE_BROWSER=true` ajoute le navigateur à
l’inventaire et aux transactions. Sans elle, les trois composants historiques
restent seuls gérés ; l’activation est refusée dans une pile de production.
Le navigateur doit préexister : le Manager ne crée pas un runtime non configuré.

Le Manager démarre le navigateur avant l’application et vérifie sa santé.
Lors de la transaction, il raccorde l’application au réseau de contrôle interne
et configure son endpoint depuis le chemin secret du navigateur existant, sans
l’exposer dans les plans ou réponses de statut.
Chaque mise à jour et restauration conserve ses réseaux, son chemin de contrôle
secret, son sandbox et réapplique le DNS public. Une image locale préexistante
est conservée par son identifiant immuable, sans téléchargement implicite.
Le changement de version Playwright reste à coordonner avec l’application.
La détection des nouvelles images publiée par les réglages Serveur concerne
actuellement l’application Mergeron, pas le runtime du navigateur. Le Manager
surveille sa santé, mais ne détecte ni n’installe automatiquement une nouvelle
image navigateur ; une mise à jour explicite et compatible reste nécessaire.
Ne jamais ajouter de capacité Linux, désactiver le sandbox ou exposer le port
de contrôle pour obtenir un démarrage.

Le DNS public évite les réponses privées du DNS local, mais **n’autorise pas**
les réseaux privés : les contrôles du proxy s’appliquent toujours à chaque
destination et redirection. Par exemple une connexion à Mergeron peut rediriger
vers Authentik ; les deux domaines doivent résoudre vers des adresses publiques.

## Vérifications

- Tests du proxy public-only : `node --test deployment/browser/public-proxy.test.mjs`.
- Tests backend `src/browser` : droits, séparation des sessions, quotas, URL,
  coordonnées et image périmée. Inclus dans les checks de PR.
- Tests frontend : navigation, pointage, preuve non fiable, capture vers le
  brouillon, conservation du texte existant et rejet des mauvaises conversations.
- Test réel opt-in : définir `MERGERON_BROWSER_TEST_EXECUTABLE` vers un Chromium
  de test puis exécuter `vitest run src/browser/browser.integration.spec.ts`.
  Le test utilise un serveur HTTP loopback éphémère sans données utilisateur,
  vérifie une page `X-Frame-Options: DENY` et sélectionne son bouton. Cette
  exception de fixture ne modifie pas la politique réseau de production.
