# Administration Codex : listes, enregistrement et version du CLI

## Organisation des paramètres

Les paramètres Codex utilisent un panneau avec un en-tête ou une navigation de
sous-onglets fixes, un contenu défilant et un pied d’actions fixe **dans le
panneau**. Les intégrations gardent leur interface existante. Les grands éditeurs
utilisent toute la largeur du contenu disponible.

| Onglet                                             | Champs et fonctions conservés                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compte                                             | Identité, fournisseur, URL masquée, variable et état des identifiants ; quotas et crédits selon le compte ; actualisation, connexion ChatGPT, changement de compte et déconnexion.                                                                                                                        |
| Codex CLI                                          | Versions, intégrité, paquet du Manager et empreinte, vérification, installation validée, installation/mise à jour officielle lorsqu’autorisée, restauration précédente, confirmations et notes de version.                                                                                                |
| Agents locaux                                      | Activation, URL privée, modèles autorisés, contexte ; enregistrement, vérification et redémarrage conditionnel des métadonnées. Le bouton de soumission conserve explicitement le formulaire propriétaire.                                                                                                |
| Profil                                             | Profil actif, uniquement lorsque des profils sont configurés.                                                                                                                                                                                                                                             |
| Modèle → Modèles par défaut                        | `model`, `review_model`, `model_provider`, valeurs personnalisées et origine des valeurs.                                                                                                                                                                                                                 |
| Modèle → Contexte                                  | `model_context_window`, `model_auto_compact_token_limit`.                                                                                                                                                                                                                                                 |
| Modèle → Catalogue / JSON du catalogue             | Un même brouillon conservé entre les deux vues, initialisation, ajout/modification/suppression d’une entrée, toutes les propriétés dynamiques des modèles, JSON, validation, enregistrement, application/redémarrage et récupération. Les propriétés inconnues restent conservées par l’éditeur existant. |
| Instructions → Consignes communes                  | Texte administrateur (12 000 caractères), texte par défaut, enregistrement et annulation du brouillon ; indépendant de la connexion Codex.                                                                                                                                                                |
| Instructions → Consignes de session / Condensation | `instructions` (champ réservé), `developer_instructions`, `compact_prompt`.                                                                                                                                                                                                                               |
| Raisonnement                                       | `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `web_search`, `service_tier` ; choix annoncés par le modèle/catalogue conservés.                                                                                                                                                  |
| Sécurité                                           | `approval_policy`, `sandbox_mode`, `approvals_reviewer` ; `sandbox_workspace_write` en lecture seule.                                                                                                                                                                                                     |
| Configuration brute                                | Éditeur TOML indépendant, brouillon conservé, enregistrement/rechargement, avertissements et indication d’un redémarrage requis.                                                                                                                                                                          |

Les barres fixes réutilisent les gestionnaires d’origine, leurs conditions de
disponibilité et leurs confirmations. Les retours à l’héritage et l’annulation
restent disponibles. Un sous-onglet enregistre uniquement ses champs visibles ;
les brouillons des autres rubriques sont conservés. Les actions d’un éditeur
masqué ne sont pas affichées dans le pied actif. La mise en page ne modifie aucune
API, permission ou règle de validation serveur.

## Agents locaux

L’onglet **Agents locaux · Ollama**, accessible sans connexion au compte OpenAI,
permet de configurer un serveur Ollama privé et ses modèles autorisés. Le menu
**+** d’un projet permet ensuite de **Créer un agent local**. Consulter le
[guide des agents locaux](local-agents.md) pour préparer les modèles, régler le
contexte et comprendre les limites réseau de ce mode.

## Intégrations

**Paramètres → Codex → Intégrations** regroupe les plugins, applications et
serveurs MCP. L’ancienne adresse `/settings?section=integrations` et les liens
`/integrations?tab=…` restent utilisables. Les définitions des trois catégories
sont accessibles au survol et au clavier ; les actions de gestion ouvrent des
fenêtres modales.

- **Plugins** : « Installés et intégrés » consulte `plugin/installed` ; les vues
  « En vedette » et « Catalogue » demandent `plugin/list` uniquement à l’ouverture.
- **Applications** : « Connectées » consulte `app/installed`, l’instantané du
  runtime. Il peut être vide avant le premier chargement des outils ; le bouton
  « Actualiser les connexions » demande explicitement `forceRefresh`. Le
  catalogue utilise séparément `app/list`. Une absence dans l’instantané ne prouve
  pas que le compte n’est pas associé chez le fournisseur.
- **Serveurs MCP** : l’administrateur peut déclarer une URL HTTP ou une commande
  locale avec ses arguments séparés. La configuration appartient au CLI exécuté
  dans Mergeron, pas au CLI du poste. Les noms réservés de la plateforme sont
  protégés et un serveur existant n’est pas remplacé par un ajout. Les éditions
  portent sur les seules propriétés de transport et vérifient la version du
  fichier utilisateur lorsqu’elle est disponible.

OAuth reste un parcours explicite après l’enregistrement. Pour un jeton, le
formulaire accepte le **nom d’une variable d’environnement existante**, jamais
sa valeur. Un exécutable local doit être disponible dans le conteneur et dispose
de l’environnement du CLI ; les permissions des agents et le filtrage réseau ne
sont pas élargis par ce formulaire. La sélection des capacités par projet reste
nécessaire.

« Vérifier le serveur enregistré » recharge les serveurs MCP configurés puis
relit leur inventaire et leur état d’authentification. Le résultat indique les
outils déclarés, sans prétendre avoir testé chacun d’eux. Le bouton prévient de
la portée globale de ce rechargement.

### Catalogue lent ou refusé

Le chargement des connecteurs par `app/list` peut contacter le répertoire distant
`connectors/directory/list`. Un refus Cloudflare 403 de ce répertoire ne doit
plus bloquer l’inventaire des connexions. Ce découplage ne garantit pas que le
catalogue distant redevienne accessible : son échec reste affiché dans la vue
Catalogue. Le backend retire les réponses HTML des erreurs JSON-RPC et borne
les autres messages avant transmission à l’interface.

Les derniers inventaires réussis restent en cache cinq minutes ; les requêtes de
lecture ne produisent pas de notifications globales et ne se relancent pas au
retour de focus. Quitter une vue annule sa requête HTTP. Le client JSON-RPC actuel
n’expose pas d’annulation de l’opération déjà reçue par le CLI : elle peut finir
côté serveur, sans mettre à jour la vue quittée. L’ouverture d’un projet ne
précharge plus les catalogues.

## Dictée avec Codex CLI

La dictée utilise uniquement le compte ChatGPT authentifié dans le CLI. Elle ne
possède plus de sélecteur de fournisseur ni de clé API propre à Mergeron. La
connexion du compte se prépare dans **Codex → Compte**, et l’exécutable dans
**Codex CLI**. Les agents locaux Ollama conservent leurs réglages distincts.

### Dictée CLI expérimentale

La session vocale désactive les serveurs MCP et les outils. Avant de transmettre
les réglages effectifs à Codex, elle omet leurs champs facultatifs sans valeur
(`null`/`undefined`), avec le même traitement que les agents de projet. Sans ce
nettoyage, un délai MCP absent peut devenir un texte vide dans les paramètres
TOML et bloquer `thread/start`, même pour un serveur désactivé. Les délais
numériques renseignés sont conservés ; les configurations MCP enregistrées ne
sont pas modifiées.

Le navigateur ouvre le microphone et génère une offre WebRTC avec une piste
audio et le canal `oai-events`. `CodexAudioService` négocie cette offre via
`thread/realtime/start` (`transport.type: "webrtc"`) et attend la notification
`thread/realtime/sdp`, pas seulement l’accusé de réception RPC. Le CLI utilise
sa propre authentification ; aucun jeton n’est extrait ni transmis au navigateur.
L’audio circule ensuite sur WebRTC, pas dans `appendAudio` ni dans un fichier
uploadé au serveur Mergeron. La connexion média du navigateur reste nécessaire.

Mergeron sélectionne explicitement le protocole **`version: "v3"`** pour le
transport WebRTC du CLI 0.164.0. Ce protocole Frameless fait générer au CLI
l’en-tête `OpenAI-Alpha: quicksilver=v2` exigé par AVAS. Sans sélection explicite,
le CLI choisit le protocole v1 et envoie `quicksilver=v1`, refusé avec
`invalid_quicksilver_alpha_header`. Ne pas confondre cet en-tête avec le protocole
de conversation `version: "v2"`, qui ne prend pas en charge WebRTC.

Ce transport exige `outputModality: "audio"`. Demander `"text"` échoue localement avec
`text realtime output modality requires realtime v2` avant toute connexion
vocale ; le protocole v2 n’est pas utilisable sur ce transport. Mergeron négocie
donc la modalité audio, désactive les pistes audio distantes et ne les attache
à aucun lecteur. Seule la transcription utilisateur est conservée. Ce refus de
configuration n’est ni un refus du microphone ni une preuve d’accès vocal refusé
sur le compte. Le diagnostic distingue cette incompatibilité d’une erreur
technique non classée, sans afficher le message natif brut.

Le transport vocal WebSocket du CLI exige une authentification par clé API,
même lorsque le compte CLI est connecté à ChatGPT. Il n’est donc pas utilisé
pour simuler une dictée sur abonnement. Un ancien client qui envoie encore un
WAV au moteur CLI reçoit une demande explicite de rechargement, sans repli API.

Le service exige une session Codex authentifiée avec ChatGPT. Le drapeau natif
`features.realtime_conversation` est activé dans cette session temporaire
uniquement ; aucune modification globale de `config.toml` n’est effectuée.

La session est temporaire, en lecture seule, sans contexte projet et sans
intégrations MCP/apps/plugins ou shell. Le service n’ouvre pas de tour d’agent.
Le CLI peut néanmoins tenter un relais natif : Mergeron l’interrompt et exige
à la fois l’accusé de réception et l’événement terminal `interrupted` corrélé.
Le résultat n’est délivré qu’après cette confirmation ; échec, expiration
ou fin non interrompue ferment la session sans rendre de brouillon. Le paramètre
`clientManagedHandoffs` ne désactive pas à lui seul ces relais entrants.
Seuls les segments
de transcription de rôle utilisateur de cette session sont retenus, jamais une
réponse de l’assistant. Audio et événements vocaux sont masqués dans l’audit RPC.
Les buffers restent en mémoire ; le service n’écrit pas de fichier audio.

Une dictée CLI peut fonctionner à la fois par installation. Les routes de session
sont réservées aux administrateurs et vérifient le propriétaire avant toute fin
ou annulation. Le microphone est coupé à l’arrêt, à l’annulation ou au départ de
la conversation. À l’arrêt explicite, la piste est d’abord rendue silencieuse
pour recevoir les derniers segments, puis entièrement libérée. La session est
fermée en fin de traitement, en cas d’erreur et à l’arrêt de l’application.
L’attente initiale est bornée à 30 secondes, l’enregistrement à deux minutes côté
navigateur et la finalisation à 15 secondes ; une session abandonnée expire.
Les fragments `thread/realtime/transcript/delta` de rôle `user` sont assemblés
exactement, espaces et répétitions conservés. À l’arrêt manuel, quatre secondes
sans nouveau fragment permettent de rendre le texte même sans événement `done`.
Un `done` remplace les fragments provisoires de son segment ; les copies des
segments canoniques ne sont pas ajoutées une deuxième fois. Les réponses de
l’assistant, les autres conversations et les instructions des `handoff_request`
ne sont jamais utilisées comme transcription. L’absence de parole reste une erreur.
Une interruption d’agent non confirmée en cinq secondes bloque le résultat.
Les journaux du service indiquent une catégorie et une étape, pas le SDP, les
paroles ni les secrets. L’interface affiche une raison bornée. Le résultat reste
dans le brouillon, jamais envoyé automatiquement.

**Limites expérimentales :** prise en charge dépendant de WebRTC dans le navigateur,
de la version du CLI et de l’accès vocal du compte. Aucun succès n’est garanti
sur chaque compte. Les fins de segments reposent sur la détection vocale native et une courte période
de stabilisation ; relire la transcription, notamment pour un long enregistrement.
En cas d’incompatibilité, coupure, silence ou expiration, une erreur explicite
est retournée sans appel de secours à l’API. La validation réelle avec le compte
de l’installation reste nécessaire avant de considérer ce chemin comme fiable.

La CI isolée vérifie séparément le précontrôle natif avec le CLI réellement
installé par le Manager et le service Mergeron compilé. L’ancien paramètre
`"text"` doit être refusé avant HTTP. Un faux service reproduit ensuite la route
ChatGPT en boucle locale : il refuse l’ancien en-tête `quicksilver=v1` et vérifie
que la sélection explicite de `v3` produit `quicksilver=v2`. Un faux canal
WebSocket local émet ensuite des fragments Frameless utilisateur et assistant,
sans `turn.done` : le vrai CLI et le service compilé doivent rendre uniquement
le texte utilisateur. Un deuxième scénario provoque un relais natif et exige
son interruption réelle avant de restituer la dictée, sans copier la délégation.
Les deux URL natives sont épinglées à la boucle locale,
et la vérification du compte est simulée : aucun compte, clé ou média réel
n’est utilisé. Ce test de compatibilité ne prouve pas l’accès vocal réel
du compte. Les tests Chromium/WebKit négocient deux pairs locaux avec de l’audio
synthétique, sans ouvrir le microphone physique ni jouer la voix distante.

## Affichage des détails techniques par agent

Dans **Capacités → Détails techniques**, choisir :

- **Sans détails techniques** : les activités techniques consécutives sont regroupées
  derrière une ligne dépliable. Les réponses de l’agent restent intégrales, dans leur ordre.
- **Détails repliés** (par défaut) : une ligne par activité ; cliquer pour consulter
  les commandes, résultats, logs ou changements de fichiers.
- **Tout afficher** : les activités techniques et leurs contenus sont ouverts par défaut.

Le choix est enregistré côté serveur pour cet agent et s’applique immédiatement
à l’historique déjà affiché et aux nouveaux événements. Rien n’est supprimé :
on peut déplier les détails ou changer de mode à tout moment. Les erreurs connues,
questions et approbations en attente restent visibles, indépendamment du mode.
Les résultats visuels et les réponses de l’agent restent affichés.

Ce réglage est uniquement visuel : aucune consigne n’est envoyée au modèle ;
la longueur des réponses, le prompt, l’effort de raisonnement et les permissions
ne sont pas modifiés. Les blocs de code présents dans le texte de la réponse ne
sont pas filtrés. La préférence accompagne les agents lors d’un export/import ZIP ;
une destination trop ancienne pour la comprendre refuse l’archive avec une explication.

## Consignes et connaissance partagée

- `instructions` est réservé à un usage futur par Codex : laisser vide et utiliser
  `AGENTS.md` pour les consignes d'un projet.
- `developer_instructions` ajoute des consignes à la session. Ce n'est pas un
  mécanisme d'autorisation des fichiers, outils ou connecteurs.
- `compact_prompt` remplace la consigne de condensation d'une conversation longue.
  Laisser vide conserve le comportement standard. Il ne partage pas les
  connaissances entre conversations.

Pour partager des connaissances sans nouveau connecteur, utiliser le même
répertoire de travail pour les conversations Codex d'un projet, avec :

| Fichier proposé    | Contenu                                              |
| ------------------ | ---------------------------------------------------- |
| `AGENTS.md`        | Consignes courtes et indication des documents à lire |
| `CONNAISSANCES.md` | Faits durables et validés, vocabulaire, contraintes  |
| `DECISIONS.md`     | Décisions datées, motivations et sources             |

Exemple de consigne dans `AGENTS.md` : « Au début d'une tâche et avant une décision
importante, relis CONNAISSANCES.md et DECISIONS.md. Propose les ajouts de
connaissance et distingue les faits validés des hypothèses. Ne remplace pas les
notes d'une autre conversation sans les relire. Ne conserve aucun secret. »

`AGENTS.md` est reconnu par Codex ; les deux autres noms sont des conventions
proposées, pas des fichiers automatiquement chargés par le CLI. Leurs contenus
doivent être lus à la demande des consignes. Chaque chat garde son propre
historique et une session déjà ouverte peut devoir relire les fichiers modifiés.
Si un projet contient plusieurs répertoires indépendants, son seul regroupement
dans le WebUI ne suffit pas à rendre ces fichiers communs : définir explicitement
leur emplacement et leur accès pour chaque espace de travail.

Cette méthode vise les agents exécutés par Codex.

Références officielles :
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference) et
[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Listes alimentées par le serveur

Les modèles et modèles de revue sont chargés depuis `model/list` du Codex installé,
en parcourant toutes les pages. Les efforts de raisonnement proviennent du modèle
sélectionné ; les niveaux de service proviennent du catalogue. Les fournisseurs
personnalisés proviennent de `model_providers` dans la configuration effective.

Les listes sont rechargées toutes les minutes lorsque le panneau est ouvert,
après une modification de configuration et après une opération sur le catalogue
ou le CLI. Une valeur déjà configurée n'est pas supprimée simplement parce
qu'elle n'est plus annoncée. Un modèle ou fournisseur non annoncé reste saisissable.

Les paramètres que Codex n'énumère pas à l'exécution, notamment certaines valeurs
de protocole de sécurité, restent définis par la version de schéma intégrée au
WebUI. Une mise à jour du CLI seule ne garantit donc pas toutes les nouveautés de
son interface : une mise à jour du WebUI peut également être nécessaire.

## Enregistrement par onglet

Les formulaires Codex et les paramètres serveur généraux, terminal, fichiers,
et sécurité utilisent une barre d'enregistrement fixe en bas de page.
Dans Codex, seul l'onglet actif est enregistré. Ses autres brouillons sont gardés
pendant la navigation entre les sous-onglets. Annuler rétablit les valeurs de cet
onglet. Les champs Codex sont validés avant un envoi groupé.

Les paramètres serveur utilisent la route groupée existante : toutes les valeurs
sont validées avant leur écriture atomique. En cas d'échec, les changements
non enregistrés sont conservés. Les actions immédiates (connexion, déconnexion,
installation d'une intégration, réinitialisation) restent distinctes d'un
enregistrement de formulaire. Le catalogue distingue toujours l'enregistrement
du brouillon et son application avec redémarrage.

## Version et mise à jour du CLI

Dans **Paramètres > Codex CLI**, un administrateur peut :

- installer le CLI lors de la première utilisation ;
- lire la version de l'exécutable utilisé par le serveur géré ;
- vérifier la dernière version stable de `@openai/codex` sur le registre npm officiel ;
- installer cette version après confirmation ;
- revenir à la sélection précédente lorsqu'elle existe.

La dernière version publiée est mise en cache pendant 15 minutes. Le bouton de
vérification relance la consultation. Un échec réseau affiche un état inconnu,
jamais une fausse indication « à jour ». Le proxy HTTP/HTTPS configuré est transmis
aux commandes npm ; `.npmjs.org` doit rester autorisé dans Squid.

### Installation et protections

L'image d'exécution ne contient aucun CLI Codex. Elle reste néanmoins saine et
permet d'accéder à l'administration lorsqu'aucun CLI n'est encore installé. Dans
ce cas, le serveur géré reste arrêté sans boucle de redémarrage et l'entrée
**Codex CLI** affiche un indicateur demandant la première installation.

L'installation ne modifie ni l'image en lecture seule, ni le préfixe npm global.
Les téléchargements sont effectués sous `CODEX_HOME/webui/cli/releases`, avec
scripts npm désactivés, durée et sortie bornées. L'exécutable doit annoncer la
version attendue avant toute activation. Seules les versions stables exactes
`majeure.mineure.correctif` sont acceptées, sans commande libre ni URL de paquet
fournie par le navigateur.

La sélection persistante est enregistrée atomiquement dans
`CODEX_HOME/webui/cli/selection.json`. Les outils auxiliaires de sandbox sont ceux
de la même version. Un répartiteur stable dans `~/.local/bin` applique cette même
sélection au serveur géré, à `codex` dans les terminaux et aux outils auxiliaires.
Une mise à jour de l'image ne change donc pas la version active du CLI.

Sur une installation existante, l'ancien CLI global reste utilisable comme
solution de repli. La première mise à jour effectuée depuis l'interface active le
stockage persistant géré, sans interrompre la disponibilité pendant la migration.

Une exclusion mutuelle empêche les mutations concurrentes pendant l'opération.
Les vérifications d'activité du catalogue sont réutilisées avant le téléchargement
et avant la bascule. L'opération est refusée si l'inactivité du serveur géré n'est
pas établie. Cette vérification ne constitue pas une barrière globale pour des
clients Codex externes ou des activités autonomes non observables.

Si l'activation d'une mise à jour échoue, la sélection précédente est restaurée
et un redémarrage est tenté. Si cette récupération échoue aussi, l'erreur
l'indique explicitement. Un retour manuel est possible lorsque le serveur est
complètement arrêté. Pendant une toute première installation, un échec conserve
simplement l'état « non installé » et l'administration reste accessible.

**Sauvegarder le répertoire Codex avant une mise à jour.** Une nouvelle version
peut migrer ses données : le retour à l'ancien exécutable ne restaure pas ces
données et ne garantit pas leur rétrocompatibilité. L'initialisation réussie du
nouveau CLI ne garantit pas la compatibilité de tous ses protocoles avec le WebUI.

La gestion intégrée est réservée à Linux x64/arm64. Si `CODEX_BIN` est défini,
l'installation est considérée comme externe : seule la consultation est proposée.
La version du CLI choisie persiste aux redémarrages du conteneur ; mettre à jour
l'image ne supprime pas cette sélection.

Les versions téléchargées sont conservées pour faciliter les retours arrière ;
aucune purge automatique de ce répertoire persistant n'est effectuée.

## Retrait du mode de conversation historique

La migration `0075_retire_simple_conversations` supprime les conversations légères
et leurs messages, les propriétaires et références de dossiers associés, ainsi
que les anciens choix de moteur. Elle nettoie les liens des tâches, livrables et
l’ordre de la sidebar en conservant les agents, documents, fichiers, versions,
connaissances déjà acceptées et historique de validation. Les propositions de
connaissances conservent leur contenu et leur historique, sans lien d’ouverture
vers une conversation supprimée.

Les API de ce mode et le client direct `/v1/responses` sont retirés. La connexion
par clé API n’est plus proposée dans Compte Codex et le serveur refuse ce type de
nouvelle connexion. La dictée WebRTC a ses propres routes `voice-dictation` et
les rapports d’automatisation passent par un échange CLI éphémère en lecture
seule. Les agents locaux restent disponibles.

Effectuer une sauvegarde avant cette migration : la suppression des conversations
n’est pas réversible depuis l’application. Un retour à l’ancienne version exige
une restauration cohérente de la sauvegarde. Les imports de ZIP historiques
ignorent désormais ces conversations ; ils ne peuvent pas les réintroduire.
Les anciens fichiers de secret fournis par l’hôte et les sauvegardes existantes
ne sont pas purgés : l’application ne les lit plus pour ce mode et les nouveaux
modèles d’installation ne demandent plus leur montage.
