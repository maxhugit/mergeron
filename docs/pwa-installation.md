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
