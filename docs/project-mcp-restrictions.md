# Intégrations autorisées par projet

La sélection MCP et Applications est une liste d'autorisations, pas un filtre
d'affichage. Une sélection vide désactive les applications (y compris le
catalogue natif `codex_apps`) et les serveurs MCP directs ou fournis par les
plugins. Les compétences d'un plugin restent indépendantes de ses serveurs MCP.
Les conversations sans projet gardent leurs réglages globaux.

Les règles sont résolues depuis le projet réellement associé à la conversation.
Un `cwd` fourni par un client ne permet pas de choisir les droits d'un autre
projet. Les transports MCP complets et les désactivations globales sont préservés.
Un échec de lecture des règles ou du catalogue n'autorise jamais un repli vers les
outils globaux.

Cette règle limite les outils MCP exposés par Mergeron à la conversation. Elle
ne remplace pas un cloisonnement des identifiants et du réseau pour des scripts,
clients externes ou commandes en accès complet ; cette isolation nécessite une
frontière distincte. Ne pas présenter la sélection comme un pare-feu général.

Les reprises de conversations conservées reçoivent les règles actuelles. Core
peut conserver les connexions d'une session déjà chargée malgré des overrides
sur `thread/resume` : une empreinte de règles par génération détecte ce cas avant
le prochain tour et impose le remplacement des connexions. Les réponses d'une
ancienne génération ne peuvent pas être utilisées pour valider la nouvelle.

Modifier une sélection renouvelle le moteur Codex, sans rejouer les messages ni
effacer les conversations. Cette opération est exclusive et n'est acceptée que
lorsque le moteur peut établir l'absence de travail actif. Sinon, la modification
est refusée avec un conflit et la sélection précédente est conservée : arrêter
les agents actifs, puis réessayer. Les sessions inactives sont réattachées avec
leurs restrictions après ce renouvellement. Aucun changement global du compte
ou des connecteurs n'est effectué.

Pour vérifier les connexions réellement chargées, après ouverture de la
conversation, utiliser `GET /api/mcp-servers?threadId=<id>&detail=toolsAndAuthOnly`.
L'accès à la conversation est vérifié ; sans `threadId`, cette route reste le
catalogue global d'administration, qui n'est pas une preuve des droits d'un agent.

La CI teste la reprise d'une conversation avec un faux serveur MCP local dans
un conteneur sans réseau ni compte : aucun outil Home Assistant ou autre outil
réel n'est appelé. La régression native couvre la révocation puis la réactivation
du seul serveur sélectionné sans créer une nouvelle conversation.
