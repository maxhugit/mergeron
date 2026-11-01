# Administration Codex : listes, enregistrement et version du CLI

## Chat et Audio

Les réglages du chat simple sont regroupés dans **Codex → Chat et Audio**,
entre les onglets Modèle et Instructions. L’ancienne URL
`/settings?section=simpleChat` ouvre ce même onglet ; l’entrée séparée de la
sidebar est retirée. Cet onglet reste accessible sans connexion Codex pour
permettre la configuration du mode API.

Deux choix indépendants sont enregistrés côté serveur :

- moteur du chat : clé API OpenAI ou session Codex CLI ;
- moteur de dictée : clé API OpenAI ou **Codex CLI — expérimental**.

Sans réglage audio explicite, la dictée suit le moteur du chat. Après un choix
audio enregistré, changer le moteur du chat ne le modifie plus. La clé API est
commune aux fonctions qui choisissent explicitement ce moteur ; elle n’est jamais
utilisée comme repli en cas d’échec du CLI.

### Dictée CLI expérimentale

Le moteur API conserve l’enregistrement WAV PCM16 mono 24 kHz. Pour le moteur
CLI, le navigateur ouvre le microphone et génère une offre WebRTC avec une piste
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
intégrations MCP/apps/plugins ou shell. Le service n’ouvre pas de tour d’agent ;
une tentative de tour déclenche interruption et fermeture. Seuls les segments
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
que la sélection explicite de `v3` produit `quicksilver=v2`. Il refuse également
la création du média après cette vérification ;
et la vérification du compte est simulée : aucun compte, clé, média ou service
OpenAI n’est utilisé. Ce test de compatibilité ne prouve pas l’accès vocal réel
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

Cette méthode vise les conversations exécutées par Codex. Le chat simple utilisant
directement l'API OpenAI n'importe pas automatiquement ces fichiers : une
fonction d'injection du contexte serait nécessaire pour lui donner le même accès.

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
sécurité et chat simple utilisent une barre d'enregistrement fixe en bas de page.
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
