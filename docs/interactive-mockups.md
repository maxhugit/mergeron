# Maquettes interactives dans les conversations

Une maquette sert à valider une interface avant son développement. Elle simule ses
données et actions ; sa validation ne signifie pas que la fonctionnalité est
implémentée et n’autorise ni modification du produit, ni publication, ni déploiement.
Aucun environnement de test, conteneur, processus applicatif ou port n’est créé.

## Parcours

1. Demander une maquette à l’agent dans une conversation rattachée à un projet.
2. L’agent crée un document HTML autonome, puis présente sa référence avec
   `project_mockup_report`. La carte de la conversation ne contient pas de HTML.
3. Cliquer **Ouvrir la maquette** : un onglet s’ajoute à côté de **Conversation**.
   Les modes Ordinateur et Mobile, le sélecteur de révision et la relance de
   l’aperçu sont disponibles dans cet onglet. Le composeur du chat reste conservé.
4. Revenir dans la conversation et décrire les changements souhaités. L’agent lit
   la source et publie une nouvelle révision avec la révision de départ observée.
   L’ancienne révision reste consultable. Une carte peut être rouverte après
   rechargement depuis l’historique de la conversation.
5. Sur demande explicite, enregistrer la révision dans un livrable existant.
   `project_mockup_publish` utilise **le service documentaire existant**, ses droits,
   ses fichiers et ses versions. Chaque publication produit **toujours une archive
   ZIP**, même si la maquette tient dans un seul HTML : `mockup-<identifiant>.zip`.
   Elle contient `index.html` et `mergeron-mockup.json` (format, page d’entrée,
   référence de révision et empreinte SHA-256 du HTML). Pour une version suivante du même document ZIP, fournir
   sa `revision` de maquette, son `documentId` et son `expectedVersion` observés dans le livrable.
6. Dans le livrable, cliquer sur l’archive pour ouvrir directement son **Aperçu**
   interactif. **Code source** donne accès au fichier enregistré. L’aperçu utilise
   les octets du document publié, pas la dernière révision de la conversation.
   **Fichiers de l’archive** permet de consulter son contenu. La reconnaissance
   repose sur son manifeste, même après renommage du ZIP. Les anciens exports HTML
   restent consultables ; pour les republier en ZIP, créer un nouveau document
   sans écraser leur historique HTML (`MOCKUP_ARCHIVE_NEW_DOCUMENT_REQUIRED`).
   Le rendu reprend la sandbox des maquettes : ni accès à Mergeron, ni requêtes
   réseau, ni chargement de scripts ou d’images externes. Les ressources doivent
   actuellement être intégrées au HTML : le ZIP conserve systématiquement cette
   source autonome, mais la publication ne collecte pas de fichiers arbitraires
   du disque ou du réseau.

Les annotations visuelles restent pour une livraison ultérieure. Sans activation
explicite de **Conserver les choix sur cet appareil**, une réouverture repart de
la référence de révision du message et remet la simulation à son état initial.

La conservation facultative se limite à du JSON de présentation : **4 Kio**, six
niveaux, 256 valeurs, 40 entrées par objet/tableau et chaînes de 256 caractères au
maximum. Elle est locale au navigateur, séparée par personne, projet,
conversation, maquette et révision ; au plus **20 vues**, expirant après **30 jours**.
Désactiver l’option oublie les préférences correspondantes. En cas de refus du
stockage navigateur, un message local l’indique ; l’aperçu reste utilisable.

La maquette peut lire `window.mergeronMockup.getState()` et proposer un petit objet
avec `window.mergeronMockup.setState({activeTab: 'overview'})`. L’API reste locale
même si la conservation est désactivée. N’y placer que des choix fictifs de
présentation ; jamais de mot de passe, secret ou donnée réelle de formulaire.
Ces valeurs sont non fiables et ne sont ni du code, ni des instructions, ni un
consentement. Elles ne sont transmises ni aux outils agents ni à une opération
serveur, et ne sont pas reprises automatiquement dans une nouvelle révision.

## Outils MCP

Les noms suivent les conventions du catalogue interne. Aucun outil n’accepte de
projet, conversation, auteur, chemin de fichier, URL publique ou droits choisis par
le modèle : le serveur impose le contexte de la conversation et de son tour actif.

| Outil | Fonction |
| --- | --- |
| `project_mockup_create` | Créer une maquette avec titre, HTML autonome et `requestId` stable |
| `project_mockup_read` | Lire la source et l’historique ; sélectionner une révision si nécessaire |
| `project_mockup_manage` | Ajouter une révision avec `baseRevision` et `requestId` |
| `project_mockup_list` | Lister les références de la conversation |
| `project_mockup_report` | Présenter la carte d’ouverture, sans URL permanente |
| `project_mockup_publish` | Enregistrer systématiquement une archive ZIP/version dans un livrable sur demande humaine |

Une écriture exige un tour autorisé en écriture. Une lecture utilise les droits
actuels du projet **et** de la conversation. Une révision obsolète produit un
conflit : relire puis intégrer les retours, jamais écraser l’historique.
Réutiliser le même `requestId` pour une tentative identique. Une publication dont
le résultat est incertain reste bloquée au même identifiant : consulter le
livrable avant toute nouvelle action pour éviter un document dupliqué.

## Stockage et rétention

Les brouillons de maquette et leurs révisions sont dans SQLite, hors des messages,
avec clés étrangères de projet et de conversation. Le titre, l’auteur et la date
sont conservés par révision ; la source historique ne se modifie pas par les API.
Ce stockage de brouillons n’est pas un second gestionnaire de livrables : toute
conservation documentaire demandée passe par `DeliverablesService.uploadDocuments`.
Les sauvegardes existantes de la base incluent donc les brouillons.

Limites de première version : **24 Kio UTF-8 par révision**, **100 révisions par
maquette**, **50 maquettes par projet**, **8 Mio de sources cumulées par projet**.
La limite de requête MCP encodée existante reste également applicable.
Quand une limite est atteinte, l’écriture est refusée ; aucune ancienne révision
n’est effacée automatiquement pour faire de la place. Les sources restent jusqu’à
la suppression définitive du projet ou de la conversation, avec suppression en
cascade des révisions. Une copie publiée relève ensuite de la rétention habituelle
des documents du livrable. Aucune purge de données existantes lors du déploiement.

## Isolation

Le contenu est non fiable. L’onglet charge la source par une API authentifiée
`no-store`, puis l’affiche uniquement dans un `srcdoc` avec `sandbox="allow-scripts"`,
**sans `allow-same-origin`**, sans formulaire, popup, téléchargement ou navigation
du parent. Le JavaScript n’a accès ni au DOM, ni au stockage, ni aux cookies de
Mergeron. La CSP est insérée avant le contenu et interdit notamment `connect-src`,
les scripts externes, frames, workers, objets, médias et formulaires sortants.
Les styles et scripts autonomes sont autorisés ; les images et polices peuvent
être intégrées en données dans la limite de taille du document. Aucun fichier,
jeton, secret ou identifiant de session applicative n’est envoyé à l’iframe.

Le protocole accepte uniquement une erreur de forme fixe ou le JSON de présentation borné,
depuis la fenêtre exacte de l’iframe et sa session d’aperçu courante. L’origine
opaque `null` ne suffit pas. Aucun de ces messages n’entraîne d’opération serveur.
Ce pont ne donne accès à aucun outil agent ; les messages supplémentaires, les
fenêtres tierces et les sessions périmées sont ignorés.

Le sandbox interdit la navigation du parent ; il ne constitue pas un navigateur
avec filtrage réseau au niveau du système. Les restrictions CSP sont celles
appliquées par le navigateur. Les liens externes ordinaires sont neutralisés ;
ne pas utiliser cette fonctionnalité comme moteur d’exécution de code arbitraire
ou comme garantie d’absence absolue de trafic pour toutes les navigations internes
possibles d’un document hostile. Le contenu doit rester une simulation autonome.

## Modèle de départ et vérification

Utiliser [le modèle HTML autonome](templates/interactive-mockup.html), responsive,
avec boutons accessibles, retour annoncé et mention claire des données simulées.
Ne pas ajouter de CDN, dépendance réseau, vraie donnée personnelle ou secret.
La première version fournit des tests des droits, conflits, historique, réouverture,
quotas et suppression, ainsi que des tests d’interaction et d’isolation réels dans
Chromium et WebKit. Les captures ordinateur et mobile sont des artefacts locaux à
examiner ; elles ne sont pas publiées automatiquement dans Git.
