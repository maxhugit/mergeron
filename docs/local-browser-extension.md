# Navigateur local Chrome / Edge / Safari Mac — préversion

Le navigateur isolé reste disponible sans extension. À chaque ouverture de navigateur,
Mergeron propose explicitement les deux modes, sans détection imposant un mode ni
repli automatique. Aucun déploiement n'est nécessaire pour charger manuellement les
sources de l'extension ; le relais et l'interface doivent néanmoins être présents
sur l'instance Mergeron utilisée.

## Installation et essai

1. Télécharger `mergeron-browser-extension.zip` dans la fenêtre d'association et
   l'extraire dans un dossier durable. Le build web génère ce ZIP depuis
   `web/browser-extension/`, sans dépendance ni code distant.
2. Dans `chrome://extensions` ou `edge://extensions`, activer le mode développeur
   puis **Charger l'extension non empaquetée** et sélectionner le dossier extrait.
3. Ouvrir les options de l'extension, saisir uniquement l'origine HTTPS de Mergeron
   et accepter l'autorisation pour cette origine. Recharger Mergeron.
4. Dans une conversation, utiliser **Navigateur → Navigateur local · extension (test)** puis
   demander l'association. Vérifier le code affiché dans Mergeron et dans l'extension,
   puis confirmer dans l'extension.
5. Dans l'onglet HTTPS à partager, utiliser l'icône de l'extension, sélectionner
   l'agent et cliquer **Pointer** pour partager cet onglet et démarrer le pointeur en un geste.
   **Partager / reprendre cet onglet** reste disponible pour la lecture par l'agent sans pointage.
6. Demander à l'agent de lire la page avec `local_browser_read`, puis une action.
   Autoriser ou refuser cette action dans Mergeron. Le retour initial n'est qu'une
   mise en attente ; l'agent doit lire le résultat avec son `commandId`.
7. Pour une passkey, suspendre le partage, effectuer soi-même l'authentification dans
   le navigateur natif puis partager de nouveau la page. Mergeron ne pilote pas
   le dialogue système et n'exporte aucune clé passkey.

Le bouton Navigateur regroupe les deux modes. Son indicateur signale le partage
actif ou une intervention attendue de l’extension. L’association ouvre une fenêtre
compacte ; elle ne crée pas d’onglet de navigateur dans la conversation et ne réduit
pas sa largeur. Fermer cette fenêtre conserve le partage et la réception des
annotations dans le message en préparation.

### Safari sur Mac (18.4 minimum)

Le build génère aussi `mergeron-browser-extension-safari.zip`, téléchargeable dans
le même panneau. Les scripts et permissions sont identiques au paquet Chrome/Edge ;
seul le manifeste change : minimum Safari 18.4 et retrait de `minimum_chrome_version`.
Cette cible est limitée au Mac ; aucun conteneur iOS/iPadOS n'est fourni.

1. Dans Safari, afficher les fonctionnalités pour les développeurs web via
   **Réglages → Avancés** si nécessaire.
2. **Réglages → Développeur → Ajouter une extension temporaire** ; valider soi-même
   la demande d'autorisation non signée et sélectionner le ZIP Safari ou son dossier.
3. Ouvrir **Configurer l'instance** depuis l'icône de l'extension, autoriser seulement
   l'origine HTTPS Mergeron, puis recharger Mergeron.
4. Suivre le même appairage/partage que Chrome/Edge. L'onglet Mergeron et la page
   partagée doivent appartenir au même navigateur et au même profil.

Safari supprime cette installation à sa fermeture ou après 24 heures. Il faut
réinstaller puis associer à nouveau ; ce paquet n'est pas une application Mac signée
ou notariée. Aucun réglage de sécurité Safari n'est modifié par Mergeron ou le build.
Pour une distribution durable, l'extension devra être empaquetée/signée séparément.

Références Apple : [installation de test](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension),
[API et compatibilité](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari),
[installation temporaire depuis Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/).

## Limites assumées

- Préversion administrateur uniquement, sans impersonation ; ordinateur Chrome/Edge
  ou Safari Mac 18.4+. Pas de prise en charge iPhone/iPad.
- La page native reste un onglet réel, pas une iframe dans Mergeron. Aucun panneau
  local permanent : le bouton ouvre une fenêtre d'association et de consentement.
- L'onglet Mergeron doit rester ouvert/authentifié. Quitter la conversation ou fermer
  Mergeron révoque le partage ; fermer la fenêtre d'association ne l'interrompt pas.
  Le véritable onglet natif reste ouvert. Retourner
  dans l'agent nécessite une nouvelle association, sans perte de la page native.
- Une navigation ou un rechargement suspend le partage, même sur le même site.
  Un clic explicite sur **Pointer** reprend le partage du nouvel onglet actif avec
  une nouvelle époque et de nouveaux identifiants de document. Aucun suivi silencieux
  des onglets, aucune ancienne commande rejouée. Les commandes ne traversent pas
  d'origine et ne ciblent pas d'iframe, page interne ou boutique d'extensions.
  L'instance Mergeron de contrôle peut être partagée en mode **annotation uniquement** :
  le worker et le script de page refusent toutes les commandes de l'agent, y compris
  l'observation. Le relais serveur est suspendu pour ne pas piloter ses consentements.
- La lecture transmet du texte visible borné et des éléments observés, pas les valeurs
  des champs, cookies, stockage du site ni capture automatique. Du texte privé affiché
  hors des champs peut néanmoins être transmis : partager uniquement une page adaptée.
- Les mots de passe/OTP détectés suspendent le partage. La détection n'est pas une
  classification infaillible de tous les secrets : pause manuelle obligatoire pour
  toute authentification. Les champs sensibles sont refusés par les actions.
- Le pointeur est activé dans le popup de l'extension. Son parcours est décrit ci-dessous.
- Une commande périmée, refusée ou au résultat incertain n'est jamais rejouée.
- Une modification du DOM entre l'observation et l'approbation invalide l'action.
  Certaines pages très dynamiques peuvent donc nécessiter une nouvelle observation
  ou une interaction manuelle dans cette première version.
- Les mises à jour de l'extension sont manuelles ; aucun store ni autoupdate dans cette V1.

## Pointeur et rédaction dans la conversation (extension 0.4.0)

1. Dans l'onglet au premier plan, ouvrir l'icône puis **Pointer un élément**.
   Ce geste reprend le partage pour l'agent choisi, y compris après navigation ou rechargement.
   Un cadre bleu suit le survol. **Échap** annule ; le pointeur expire après une minute.
2. Cliquer l'élément : le clic du site est intercepté. L'extension capture la zone
   visible et ouvre un aperçu qui lui appartient (fenêtre ou onglet selon le navigateur).
3. Vérifier l'aperçu avec cadre bleu et repère 1. Rien n'est transmis à Mergeron avant
   **Ajouter au message dans Mergeron**. **Annuler** détruit la capture privée.
   Aucun champ de commentaire séparé : on rédige uniquement dans la conversation.
4. Après validation explicite, le relais ajoute le repère et le JPEG marqué à la
   zone de saisie normale de cet agent via l'upload existant. Le texte déjà saisi est
   conservé. La conversation est sélectionnée ; l'utilisateur complète puis envoie
   lui-même son message. Aucun tour de chat n'est démarré automatiquement.

La fenêtre d'association est indépendante du relais : la fermer ne révoque pas la
connexion et n'occupe plus la moitié de l'interface. Une nouvelle demande d'action
ouvre la fenêtre pour consentement explicite ; la fermer n'approuve rien. Les anciens
onglets locaux persistés sont retirés sans convertir leur session en navigateur isolé.
Les onglets et sessions isolés restent inchangés. Quitter l'agent révoque toujours la connexion.

Le frontend Mergeron et l'extension doivent tous deux prendre en charge le protocole
d'annotation 3. Sinon, le popup demande de mettre à jour Mergeron au lieu d'accepter
une annotation impossible à livrer. Après mise à jour, **recharger Mergeron et la page
partagée**, puis refaire l'association ; les anciens scripts injectés sont refusés.

La capture nécessite le geste utilisateur `activeTab`, aucun nouveau droit global.
Le document, l'onglet actif, le défilement, les dimensions et la révision du DOM sont
vérifiés autour de la capture ; un changement détecté annule l'opération. Les commandes
de l'agent sont suspendues pendant le pointage et la prévisualisation. Les champs et iframes sont
recouverts uniquement dans le JPEG, sans masquage rose sur la page au survol. Cela ne
détecte pas tous les secrets affichés (par exemple un champ custom dans un shadow DOM) :
vérifier impérativement l'image et ne pas annoter une page contenant des données privées.

Les pixels bruts restent dans la mémoire du worker, ne sont accessibles qu'une fois
par l'éditeur lié à cette capture et ne traversent jamais le bridge Mergeron. Un
redémarrage du worker les perd volontairement. L'aperçu est redimensionné et borné à
750 ko encodés ; seul ce JPEG traité est conservé en `storage.session` après validation.
Une annotation est liée à la session et à l'onglet Mergeron qui l'a créée, puis effacée
après accusé d'ajout à la zone de saisie ou expiration (15 minutes). Une erreur d'ajout demande
une reprise manuelle. Si seul l'accusé échoue, la reprise ne renvoie pas l'image deux fois.

## Frontières de confiance

L'extension Manifest V3 utilise `activeTab`, `scripting` et `storage`. Le motif HTTPS
optionnel sert exclusivement à demander l'origine Mergeron configurée. Aucun droit
global aux sites n'est accordé par défaut ; les pages partagées utilisent le geste
utilisateur `activeTab`. Aucun `cookies`, `debugger`, `history`, code distant ou
`externally_connectable`. Le bridge est enregistré uniquement sur l'origine autorisée,
dans le frame principal. Les messages viennent de la même fenêtre et origine.

Le relais passe par l'onglet Mergeron déjà authentifié : aucun bearer ni cookie n'est
copié dans l'extension. L'identifiant de session n'est pas un jeton d'authentification.
Le serveur exige les droits actuels administrateur/conversation sur chaque requête.
Chaque commande MCP reste liée au propriétaire, à l'agent, au tour actif et à sa
politique lecture seule ; ces droits sont revérifiés avant approbation et exécution.

Les associations sont liées à l'onglet Mergeron, confirmées en deux minutes et stockées
en `storage.session` : survivent au sommeil du worker, pas au redémarrage du
navigateur. La session serveur expire après quinze minutes sans relais. Chaque action
expire après une minute. Une nouvelle époque/document invalide les commandes ; les
identifiants d'exécution sont enregistrés avant envoi pour prévenir les doubles actions.
Le texte du site reste une donnée non fiable, jamais une instruction ou autorisation.

Le code privilégie l'espace de noms natif `browser` (Promesses sur Safari), avec
repli sur `chrome` pour les versions Chromium antérieures. L'absence de
`storage.session` ou des API nécessaires bloque le relais : pas de repli vers un
stockage persistant des associations. À une mise à jour ou un démarrage du navigateur,
le worker révoque les partages et réenregistre le bridge uniquement sur l'origine
déjà configurée et encore autorisée. Cela couvre la perte des scripts dynamiques à
une mise à jour Safari, sans donner de nouveaux droits ni reprendre des commandes.

Le bridge suppose le code et l'origine Mergeron de confiance : une compromission/XSS
sur cette origine est aussi une compromission de ce relais. L'extension ne constitue
pas une isolation contre le serveur auquel l'utilisateur choisit de faire confiance.

## Vérification

- Tests de broker, contrôleur et outils MCP : propriétaire, administrateur, tour actif,
  lecture seule, approbation, expiration, origine, unicité et absence de chevauchement.
- Tests web : choix explicite, absence d'extension sans fallback, ajout de l'image
  uniquement après validation, absence de doublon après échec d'accusé, absence de
  capture dans le relais des commandes et retrait des anciens panneaux locaux sans
  keepalive/dispose isolé. La fermeture de la fenêtre d'association ne coupe pas le relais.
- `local-browser-connection.browser.tsx` : vraie mise en page Chromium/WebKit à
  1280 et 390 pixels, zone de saisie pleine largeur après fermeture de la fenêtre,
  réception de la capture dans le texte existant, sans envoi de tour de chat.
- `node --test scripts/browser-extension-portability.test.mjs` : paquets déterministes,
  contenu/permissions identiques hors manifeste, espace de noms `browser` sans `chrome`,
  restauration du bridge sans réautorisation et révocation des sessions après mise à jour.
- `node scripts/test-local-browser-extension.mjs` : vrai Chromium avec profil temporaire
  et uniquement deux origines HTTPS fictives interceptées. Le harness préautorise ces
  deux origines pour tester les scripts MV3 sans automatiser le dialogue système
  `activeTab`/permission optionnelle. Ce n'est pas une validation de ce dialogue ni
  d'une passkey réelle. Pour le parcours d'annotation, l'API native de capture est
  simulée avec une vraie capture de la seule page fictive ; l'éditeur, le traitement
  canvas, les masques, la confirmation et la livraison sont réels. Ce test ne valide
  donc pas l'autorisation native de capture. Installer Chromium via Playwright, ou définir
  `CHROMIUM_EXECUTABLE_PATH` pour un binaire de test existant.
- `node scripts/test-local-browser-webkit.mjs` : scripts de page réels dans WebKit avec
  API d'extension simulée ; vérifie la confidentialité, les handles et le pointeur,
  mais ne simule pas le moteur d'extensions natif de Safari.
- Une validation manuelle de l'installation, du geste `activeTab` et d'une passkey
  réelle reste nécessaire sur Chrome, Edge et Safari avant diffusion large. Les
  tests Chromium, WebKit et les mocks ne constituent pas une validation Safari native.
