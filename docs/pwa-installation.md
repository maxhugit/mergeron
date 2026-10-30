# Installation de Mergeron comme application

Après connexion, ouvrir **Mon compte → Installer l’application**. Edge peut
aussi proposer son icône dans la barre d’adresse ou le menu Applications.
Le navigateur reste décisionnaire : navigation privée, règles d’entreprise,
refus récent ou installation existante peuvent empêcher la proposition.

Le manifeste protégé par Authentik doit être chargé avec
`crossorigin="use-credentials"`, même sur le même domaine. Les routes restent
authentifiées : aucune exception publique n’est ajoutée au proxy. La dev garde
son nom et ses icônes distincts de la production.

Le bouton ne lance jamais une installation sans clic. L’événement navigateur est
conservé dès le démarrage et consommé une seule fois. Sans cet événement, le
bouton affiche les instructions adaptées au menu du navigateur.

Le service worker ne conserve que les ressources statiques autorisées de sa
portée. Il refuse les réponses HTML et les redirections de connexion, joint la
session pendant le préchargement et ne nettoie que ses propres anciens caches.
Ce n’est pas un mode hors ligne pour les fichiers, conversations ou API.

Les manifestes dev et production utilisent `standalone`, sans
`window-controls-overlay`. Edge conserve ainsi sa barre de titre native sur
toute la largeur : elle permet de déplacer la fenêtre et réserve une zone aux
boutons réduire, agrandir et fermer, sans masquer les informations de Mergeron.
L’identité de l’application reste inchangée. Pour une installation existante,
Edge doit récupérer le manifeste mis à jour ; fermer puis rouvrir l’application
après cette actualisation. Un simple rechargement ne garantit pas l’application
immédiate des changements du manifeste par le navigateur.

Le test navigateur `web/src/pwa-install.browser.tsx` vérifie le vrai chargement
Chromium du manifeste derrière un cookie de session, puis les critères
d’installation via DevTools Protocol. La fixture n’existe que dans le serveur
Vitest, jamais dans l’application déployée.

Références :
- https://web.dev/articles/add-manifest
- https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/
- https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/window-controls-overlay

## Notifications des agents (Web Push)

Dans **Mon compte → Notifications des agents**, donner un nom à l’appareil,
cliquer **Activer sur cet appareil**, puis accepter la demande du navigateur.
Répéter sur chaque appareil souhaité. Rien n’est activé automatiquement.
Les trois préférences sont indépendantes : réponse terminée, approbation demandée,
question de l’agent. Le bouton de test et la liste des appareils permettent de
vérifier l’envoi et de retirer un appareil perdu. La déconnexion explicite retire
l’abonnement de ce navigateur, pas ceux des autres appareils.

Sur iPhone/iPad, Web Push nécessite iOS/iPadOS 16.4+ et l’application ajoutée à
l’écran d’accueil, ouverte depuis cette icône. Sur macOS, Safari nécessite
Ventura/Safari 16+ ; les versions actuelles de Chrome, Edge et Firefox sur
ordinateur et les navigateurs Android compatibles peuvent aussi recevoir du
Push. La disponibilité réelle est détectée, pas déduite du nom du navigateur.
Une connexion Internet reste nécessaire : les messages transitent par le service
Push du navigateur (Apple, Google, Mozilla ou Microsoft), même avec Mergeron
auto-hébergé. Une session Authentik expirée n’empêche pas l’alerte système,
mais l’ouverture de la conversation peut demander une nouvelle identification.
Le mode Concentration, les permissions du système, l’économie d’énergie ou la
fermeture complète du navigateur peuvent empêcher/retarder la réception.

### Confidentialité et destinataires

Seuls les comptes personnels actifs peuvent enregistrer/gérer leurs appareils.
Ce réglage est interdit aux comptes de service et pendant « Tester en tant que ».
Chaque appareil reçoit les catégories activées pour les agents auxquels son
propriétaire a actuellement accès. Les demandes d’approbation/question sont
réservées aux administrateurs, comme les réponses à ces demandes dans Mergeron.
Les droits et l’activité du compte sont revérifiés juste avant chaque envoi.
Les demandes déjà résolues, fils supprimés/internes et réponses interrompues ou
en erreur ne déclenchent pas d’alerte. L’ouverture du panneau ne rejoue pas l’historique.

Le titre et le texte sont génériques : aucun nom de projet, commande, document,
réponse ou question n’est affiché sur l’écran verrouillé. Le petit message chiffré
contient uniquement un identifiant d’événement, sa catégorie, l’identifiant du fil
et la langue. Le fournisseur Push connaît néanmoins l’adresse IP de l’émetteur,
les horaires et la destination. Un clic ouvre le fil dans la portée de Mergeron ;
il ne valide jamais une opération. L’identification et les droits habituels restent
nécessaires. L’expiration d’un endpoint (404/410) efface cet abonnement.

### Architecture et configuration

`PushModule` observe les véritables `turn/completed` réussis et les demandes
admises/persistées de `PendingApprovalsService`, indépendamment des onglets ouverts.
La migration `0062_web_push` ajoute les abonnements privés, les reçus de déduplication
et une file durable par appareil. Une tentative démarre au plus toutes les cinq
secondes, avec quatre essais maximum ; durée de vie de 1 h pour une réponse,
15 min pour une intervention/test. Les reçus expirent après sept jours.
Un identifiant/tag stable regroupe les réessais ambigus : ce n’est pas une garantie
de livraison « exactement une fois ». Le statut du test signifie « accepté par
le service Push », jamais une preuve d’affichage sur l’appareil.

Le serveur génère une paire VAPID par base/environnement au premier démarrage,
dans `${WEBUI_DB_PATH}.push-vapid.json` (0600, hors ressources publiques). Il faut
conserver ce fichier : les sauvegardes complète **et minimale** du Manager
l’incluent. Une clé absente après restauration invalide les anciens abonnements ;
il faut les retirer/réactiver. Une clé corrompue ou lisible par d’autres utilisateurs
désactive Push sans rotation silencieuse. `MERGERON_PUBLIC_URL` fournit le contact
VAPID HTTPS ; `WEBUI_PUSH_SUBJECT` permet un contact HTTPS ou `mailto:` spécifique.
Ne jamais partager les fichiers de clés, endpoints ou secrets d’abonnement.

API authentifiée, réservée au propriétaire de chaque appareil :

| Méthode | Route | Usage |
| --- | --- | --- |
| GET | `/api/push` | Clé VAPID publique, état de configuration et appareils du compte (sans endpoint/secret) |
| POST | `/api/push/subscriptions` | `{label, language, subscription:{endpoint,keys:{p256dh,auth}}}` issu du navigateur |
| PATCH | `/api/push/subscriptions/:id` | Préférences booléennes `completed`, `approvals`, `questions` |
| DELETE | `/api/push/subscriptions/:id` | Révoquer un appareil et ses envois en attente |
| POST | `/api/push/subscriptions/:id/test` | Test, au maximum une fois par 30 secondes |

### Déploiement : accès réseau existants

Les nouvelles installations incluent quatre destinations dans
`deployment/config/squid.conf` : `fcm.googleapis.com`, `.push.apple.com`,
`.push.services.mozilla.com`, `.notify.windows.com`. Le refus des réseaux privés,
des ports non sûrs et de toute autre destination reste inchangé. Le transport
honore `HTTPS_PROXY` (ou `https_proxy`), limite la durée totale d’une requête à
12 secondes et refuse les redirections. Sans proxy, la résolution directe est
restreinte aux mêmes fournisseurs et aux adresses IPv4 publiques.

**Une mise à jour de l’image ne remplace pas le fichier Squid persistant.** Pour
une installation existante, un administrateur doit examiner puis appliquer, sur
le serveur concerné et avec les droits du propriétaire du fichier :

```sh
node deployment/config/enable-push-egress.mjs /chemin/absolu/config/squid.conf
node deployment/config/enable-push-egress.mjs /chemin/absolu/config/squid.conf --apply
```

Sans `--apply`, aucun fichier n’est modifié. L’application ajoute uniquement les
quatre domaines manquants, vérifie les règles de refus attendues, préserve les
personnalisations et garde une copie `squid.conf.before-web-push-<id>`.
Vérifier ensuite la syntaxe avec `squid -k parse` et recharger/recréer **le Squid
de cette stack** (la configuration Docker est un bind mount de fichier : une
recréation peut être nécessaire après remplacement atomique). Ne pas modifier
la dev et la prod ensemble ni ouvrir l’ensemble de `.googleapis.com`.
Enfin, envoyer un test depuis chaque type d’appareil réel. Les tests CI valident
le protocole chiffré, les droits et les interfaces, pas la livraison Apple/Google
à un appareil personnel ni un consentement donné à sa place.

Sources : [WebKit, Web Push iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
[WebKit, Web Push macOS](https://webkit.org/blog/12945/meet-web-push/),
[MDN, Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).
