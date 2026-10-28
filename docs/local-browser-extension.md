# Navigateur local Chrome / Edge / Safari Mac — préversion

Le navigateur isolé reste disponible sans extension. À chaque ouverture de navigateur,
Mergeron propose explicitement les deux modes, sans détection imposant un mode ni
repli automatique. Aucun déploiement n'est nécessaire pour charger manuellement les
sources de l'extension ; le relais et l'interface doivent néanmoins être présents
sur l'instance Mergeron utilisée.

## Installation et essai

1. Télécharger `mergeron-browser-extension.zip` dans le panneau du mode local et
   l'extraire dans un dossier durable. Le build web génère ce ZIP depuis
   `web/browser-extension/`, sans dépendance ni code distant.
2. Dans `chrome://extensions` ou `edge://extensions`, activer le mode développeur
   puis **Charger l'extension non empaquetée** et sélectionner le dossier extrait.
3. Ouvrir les options de l'extension, saisir uniquement l'origine HTTPS de Mergeron
   et accepter l'autorisation pour cette origine. Recharger Mergeron.
4. Dans une conversation, ouvrir **Navigateur → Navigateur local · extension (test)** puis
   demander l'association. Vérifier le code affiché dans Mergeron et dans l'extension,
   puis confirmer dans l'extension.
5. Dans l'onglet HTTPS à partager, utiliser l'icône de l'extension, sélectionner
   l'agent et partager explicitement cet onglet. Aucun onglet n'est choisi automatiquement.
6. Demander à l'agent de lire la page avec `local_browser_read`, puis une action.
   Autoriser ou refuser cette action dans Mergeron. Le retour initial n'est qu'une
   mise en attente ; l'agent doit lire le résultat avec son `commandId`.
7. Pour une passkey, suspendre le partage, effectuer soi-même l'authentification dans
   le navigateur natif puis partager de nouveau la page. Mergeron ne pilote pas
   le dialogue système et n'exporte aucune clé passkey.

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
- La page native reste un onglet réel, pas une iframe dans Mergeron. Le panneau local
  affiche le partage, les consentements et l'annotation textuelle, pas un flux vidéo.
- L'onglet Mergeron doit rester ouvert/authentifié. Quitter la conversation ou fermer
  le panneau révoque le partage ; le véritable onglet natif reste ouvert. Retourner
  dans l'agent nécessite une nouvelle association, sans perte de la page native.
- Une navigation ou un rechargement suspend le partage, même sur le même site.
  L'utilisateur doit reprendre depuis l'extension. Les commandes ne traversent pas
  d'origine et ne ciblent pas d'iframe, page interne, boutique d'extensions ou
  instance Mergeron de contrôle (pour ne pas piloter ses propres consentements).
- La lecture transmet du texte visible borné et des éléments observés, pas les valeurs
  des champs, cookies, stockage du site ni captures d'écran. Du texte privé affiché
  hors des champs peut néanmoins être transmis : partager uniquement une page adaptée.
- Les mots de passe/OTP détectés suspendent le partage. La détection n'est pas une
  classification infaillible de tous les secrets : pause manuelle obligatoire pour
  toute authentification. Les champs sensibles sont refusés par les actions.
- Le pointeur est activé dans le popup de l'extension. Il ajoute, après confirmation
  dans Mergeron, une annotation textuelle au brouillon, sans envoi automatique à l'agent.
- Une commande périmée, refusée ou au résultat incertain n'est jamais rejouée.
- Une modification du DOM entre l'observation et l'approbation invalide l'action.
  Certaines pages très dynamiques peuvent donc nécessiter une nouvelle observation
  ou une interaction manuelle dans cette première version.
- Les mises à jour de l'extension sont manuelles ; aucun store ni autoupdate dans cette V1.

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
- Tests web : choix explicite, absence d'extension sans fallback, annotations sans upload,
  mode conservé sans keepalive/dispose du navigateur isolé.
- `node --test scripts/browser-extension-portability.test.mjs` : paquets déterministes,
  contenu/permissions identiques hors manifeste, espace de noms `browser` sans `chrome`,
  restauration du bridge sans réautorisation et révocation des sessions après mise à jour.
- `node scripts/test-local-browser-extension.mjs` : vrai Chromium avec profil temporaire
  et uniquement deux origines HTTPS fictives interceptées. Le harness préautorise ces
  deux origines pour tester les scripts MV3 sans automatiser le dialogue système
  `activeTab`/permission optionnelle. Ce n'est pas une validation de ce dialogue ni
  d'une passkey réelle. Installer Chromium via Playwright, ou définir
  `CHROMIUM_EXECUTABLE_PATH` pour un binaire de test existant.
- `node scripts/test-local-browser-webkit.mjs` : scripts de page réels dans WebKit avec
  API d'extension simulée ; vérifie la confidentialité, les handles et le pointeur,
  mais ne simule pas le moteur d'extensions natif de Safari.
- Une validation manuelle de l'installation, du geste `activeTab` et d'une passkey
  réelle reste nécessaire sur Chrome, Edge et Safari avant diffusion large. Les
  tests Chromium, WebKit et les mocks ne constituent pas une validation Safari native.
