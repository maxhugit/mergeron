# Travailler avec Mergeron dans OnlyOffice

Dans un document texte ou une présentation ouvert en **modification depuis Mergeron**, un panneau **Avec Mergeron** permet de choisir un agent du projet du document, de décrire une modification puis de relire la proposition avant de l’appliquer.

Les actions disponibles sont l’ajout de texte au curseur, le remplacement explicite de la sélection et, dans une présentation, l’ajout d’une diapositive après la diapositive courante. Le texte proposé ne contient pas de code à exécuter. Une nouvelle slide reprend le thème et la disposition de la slide courante lorsque l’API le permet, avec un titre et un corps de texte. La modification utilise les opérations de l’éditeur et son historique d’annulation ; l’enregistrement et les versions des livrables suivent le circuit OnlyOffice habituel.

Le plugin est annoncé par la configuration de cet éditeur seulement : il n’est ni installé globalement ni publié dans la marketplace. Les autres applications utilisant le même serveur OnlyOffice ne le chargent pas. Les aperçus en lecture seule et les tableurs ne l’activent pas. Cette intégration vise **OnlyOffice Docs 10** ; une API indisponible produit un message et ne déclenche pas une modification de remplacement sur le fichier.

## Retravailler une slide brouillon

Dans une présentation, choisir **Retravailler cette slide (nouvelle version)** et préciser les changements souhaités. L’agent reçoit le texte et la structure de la slide courante ; il propose un titre, un texte clarifié et une composition : sections empilées, deux colonnes ou cartes. Le panneau montre un aperçu de cette organisation.

**Ajouter la nouvelle slide** l’insère immédiatement après la source et la sélectionne. La source reste inchangée : comparer les deux puis choisir soi-même laquelle conserver. Le thème de la source est repris ; les illustrations, graphiques et tableaux sont copiés et regroupés dans une zone latérale, sans réécrire leur contenu ni interpréter les pixels des images. Les groupes et objets non pris en charge sont refusés explicitement, pour éviter de perdre du contenu. Dissocier les objets dans une copie si nécessaire. Limites : 50 objets, 12 000 caractères de texte source, trois sections au plus et 500 caractères par section proposée.

Si le texte, une illustration ou sa position change pendant la préparation, refaire la proposition. Aucun code généré par l’agent n’est exécuté : seules les compositions prévues par le plugin peuvent être appliquées.

## Actions au clic droit

Lorsque le plugin Mergeron est actif dans cet éditeur, le menu contextuel propose un sous-menu **Mergeron** :

- **Reformuler la sélection** prépare directement une proposition à relire.
- **Remplacer la sélection…** place le panneau sur cette action pour saisir une consigne.
- **Retravailler cette slide** est disponible dans les présentations et prépare une version supplémentaire.

Sans sélection textuelle, les deux premières actions sont désactivées. Les actions sont aussi désactivées pendant une préparation ou lorsque le compte ne peut pas lancer d’agent. Le clic droit ne remplace jamais directement le contenu : la validation reste dans le panneau. Si le plugin a été fermé, le rouvrir depuis les modules complémentaires pour retrouver ces actions ; replier son panneau conserve le plugin actif.

## Agents et propositions

La liste contient uniquement les agents actifs, non archivés et accessibles du projet propriétaire du document. Un changement de projet d’un agent, une désactivation du compte ou une révocation des droits est contrôlé aussi côté serveur, avant une proposition et avant son application. L’exécution reste soumise aux droits existants de Mergeron : les administrateurs peuvent lancer les agents ; les autres membres autorisés peuvent consulter leur liste.

La génération utilise le contexte récent de l’agent choisi (au plus deux échanges, plafonnés à 12 000 caractères) et le contenu visible transmis par l’éditeur (16 000 caractères, sélection limitée à 4 000 caractères). Elle passe par le moteur Codex configuré dans Mergeron et une session temporaire du projet en lecture seule. Elle n’envoie pas un nouveau tour dans la conversation de l’agent choisi, n’interrompt pas son travail et ne change pas ses préférences. Les consignes du projet continuent de s’appliquer.

La proposition doit être validée avec **Appliquer dans le document**. Si le texte, la sélection ou la diapositive ont changé entre-temps, le plugin demande une nouvelle proposition. Il ne remplace jamais directement le fichier sur disque pendant une édition. Pour ajouter du texte, placer le curseur sans sélectionner du texte ; pour remplacer, choisir l’action de remplacement explicitement.

Le lien du panneau expire après deux heures ou au redémarrage de Mergeron : rouvrir le document pour le renouveler. Les propositions sont temporaires et disparaissent avec ce lien. Aucun jeton Mergeron, secret OnlyOffice ou identifiant de session n’est remis au plugin. Son code peut être chargé publiquement, mais seul l’hôte Mergeron authentifié peut demander des données ou des propositions. Les messages entre fenêtres vérifient l’origine, le canal de l’éditeur et la fenêtre source.

## Mise en place sur une installation existante

L’intégration utilise le serveur et le secret JWT OnlyOffice déjà configurés. Pas de clé d’API IA supplémentaire dans OnlyOffice.

Le proxy doit autoriser en lecture les **seuls fichiers publics** sous `/api/onlyoffice/assistant/plugin/` sans connexion interactive. Les modèles Nginx natif/SSO et le routeur Traefik de ce dépôt incluent cette règle et conservent l’authentification sur `/api/onlyoffice/assistant/context` et `/api/onlyoffice/assistant/proposals`. Pour une installation existante, reporter cette règle depuis les modèles puis recharger l’Ingress ; ne pas rendre tout `/api/onlyoffice/assistant/` public. Le routeur des fichiers du plugin ne doit pas ajouter `X-Frame-Options: DENY` : sa réponse définit déjà les deux origines autorisées à l’encadrer. Conserver les protections des autres pages.

Le SDK officiel relit son manifeste public et évalue le code d’initialisation envoyé par son éditeur parent. La politique du plugin autorise donc cette lecture et `unsafe-eval` uniquement dans cette page intégrée. Avant de charger le SDK, `bootstrap.js` filtre les messages : seul le parent OnlyOffice de l’origine configurée peut envoyer ce protocole. Le pont Mergeron accepte séparément les réponses de la fenêtre hôte. Aucune proposition de l’agent n’est exécutée comme du code.

## Vérifications reproductibles

- Backend : `pnpm exec vitest run src/onlyoffice/`.
- Pont du navigateur : `pnpm --dir web exec vitest run --project unit src/components/files/viewers/onlyoffice-assistant-bridge.spec.ts src/components/files/viewers/onlyoffice-viewer.spec.tsx`.
- Plugin et pont réels avec API d’éditeur simulée : installer les navigateurs du projet, puis `node scripts/test-onlyoffice-assistant.mjs`. Chromium et WebKit vérifient insertion, remplacement, refus d’une proposition périmée (y compris une illustration déplacée), ajout et recomposition de slide, et actions du menu contextuel ; les captures ordinateur/mobile sont dans `artifacts/onlyoffice-assistant/` (surcharge possible par `OFFICE_ASSISTANT_SCREENSHOTS`). Ce test n’utilise aucun compte ni document réel.

Pour une recette avec un serveur Docs réel, utiliser deux fichiers synthétiques DOCX/PPTX dans un projet de test : vérifier le panneau, choisir un agent, appliquer une proposition, annuler, sauvegarder puis rouvrir. Ouvrir ensuite un document depuis une autre solution connectée au même serveur : le panneau doit être absent.

Références officielles : [chargement des plugins par configuration](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/plugins/), [API des présentations](https://api.onlyoffice.com/docs/plugins/interacting-with-editors/presentation-api).
