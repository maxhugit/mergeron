# Évolution fonctionnelle des workspaces

## Modèle cible

Chaque projet possède exactement un principal local et persistant, organisé par Mergeron. Un dossier actif est une référence propre à un agent, une conversation, une tâche ou un livrable. Un secondaire rattache une ressource externe au projet ; il ne remplace pas son principal et n'active aucune synchronisation implicite. Le dossier système est désormais nommé `.mergeron`.

Les administrateurs de plateforme ont accès à tous les projets ; les participants accèdent aux projets auxquels ils appartiennent. Le dossier actif ne crée aucun droit supplémentaire. Les capacités de la connexion distante limitent les opérations réellement possibles.

## Analyse de l'existant

- `ProjectWorkspaceLayout` crée déjà un principal permanent à partir de l'identifiant du projet et possède une migration relançable depuis les anciens chemins personnalisés.
- `ProjectKnowledgeService` relit les connaissances dans le principal, indépendamment du contexte de travail de la conversation. Ce comportement est conservé.
- `FilesService` protège déjà les racines permanentes et le dossier système. La protection des dossiers structurants est ajoutée dans la PR 1.
- Les historiques des livrables contiennent des chemins absolus : JSON `project_deliverable_versions.files`, colonnes `snapshot_path` et `onlyoffice_changes_path` des versions de documents. Renommer le dossier sans migrer ces références casserait les téléchargements et restaurations.
- Les agents et tâches possèdent déjà des champs `workspacePath` ou `cwd`. Les secondaires sont actuellement des chemins de dossiers locaux. Ils ne modélisent pas encore le type de connexion, les capacités ou la distinction entre ressource distante et copie locale.
- Les automatisations et les restrictions propres aux modules existent déjà. Leur intégration aux futures ressources externes doit être auditée dans les lots correspondants, sans supposer qu'un chemin actif suffit à les autoriser ou les isoler.

## Découpage en cinq PR maximum

Les PR sont successives et ciblent `main` après intégration de la précédente. Chaque étape conserve l'application utilisable et comprend ses migrations, contrôles des droits et tests ; les contrôles de sécurité ne sont pas reportés à une étape ultérieure.

| PR  | Résultat attendu                                                                                                             | Dépendance |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Principal en structure v2, `.mergeron`, reprise des connaissances et historiques, protection des dossiers structurants       | Aucune     |
| 2   | Dossier actif explicite par contexte, résolution et validation communes, affichage du chemin effectif et état « À résoudre » | PR 1       |
| 3   | Ressources secondaires typées, connexions Git, SSH/SFTP et FTP/FTPS, secrets et capacités, gestion de leur cycle de vie      | PR 2       |
| 4   | Exploitation des ressources par les agents, tâches et livrables, copies locales et isolation des activités Git               | PR 3       |
| 5   | Transferts et synchronisations explicites, aperçu, conflits, reprises et intégration des automatisations                     | PR 4       |

### PR 1 — Principal et migration Mergeron

Centraliser les noms et la version de structure. Créer les nouveaux projets dans `.mergeron` et migrer les projets v1 par renommage du dossier système. Reprendre les références des historiques dans une transaction par projet, sans déplacer les fichiers sources ni modifier les dossiers actifs. Mettre à jour les services de connaissances, de livrables, les messages d'aide FR/EN et la documentation.

Refuser les collisions entre les deux dossiers système, les marqueurs étrangers ou invalides et les liens symboliques dans la structure réservée. Préserver les instructions racine personnalisées. Ne jamais recréer un principal disparu ni promouvoir un secondaire. Protéger `documents`, `sources` et `livrables` contre les opérations destructives sur ces racines, en laissant leur contenu modifiable.

Recette : nouveaux projets, migration des connaissances, téléchargement des deux formes d'historique, archives OnlyOffice, interruption après renommage, idempotence, collisions, liens symboliques, propriété et accès aux sous-dossiers.

### PR 2 — Dossiers actifs par contexte

Introduire une référence stable composée d'une ressource et d'un chemin relatif, puis migrer les chemins existants sans les réaffecter. Définir les défauts à la création et la priorité d'une tâche sur le défaut d'un agent. Résoudre et vérifier l'appartenance au projet côté serveur pour chaque opération. Un changement affecte les prochaines opérations ; une exécution conserve son contexte de départ.

Un dossier invalide ou détaché doit être signalé et bloquer les nouvelles opérations, sans bascule silencieuse vers le principal. Supprimer le retour automatique actuel au principal lors du détachement. La navigation dans l'explorateur reste indépendante du choix actif. Afficher ressource, chemin et état dans les vues concernées.

Recette : activités simultanées indépendantes, absence d'héritage dynamique caché, tâches prioritaires, références invalides et refus interprojets, sans changer une exécution en cours.

### PR 3 — Ressources externes et connexions

Séparer la définition d'une ressource de son emplacement local éventuel. Ajouter type, adresse, racine autorisée, référence sécurisée aux secrets, capacités, mode d'accès et état de connexion. Préserver les secondaires locaux existants comme ressources locales de compatibilité.

Fournir les écrans de configuration, test, activation, désactivation et détachement. Appliquer l'autorisation du projet et les capacités dès l'ajout de chaque connecteur ; les identifiants ne sont pas transmis aux agents. Les destinations réseau autorisées doivent être contrôlées pour empêcher les connexions arbitraires initiées par des utilisateurs non autorisés. FTP non chiffré est un choix explicite, désactivé par défaut.

Recette : connexion et perte d'accès, lecture seule, confinement à la racine, absence de secrets dans les réponses/journaux et détachement sans suppression distante. Rattacher SSH n'autorise pas une commande distante.

### PR 4 — Utilisation par les activités du projet

Brancher les outils de navigation et de transfert, les dossiers actifs et les livrables sur les capacités des ressources. Refuser un dossier distant comme répertoire d'exécution local ; proposer une copie de travail explicite lorsque nécessaire. Distinguer dépôt Git et copie locale. Préparer des copies ou worktrees séparés pour les branches concurrentes, avec branche et révision visibles.

Vérifier à nouveau les droits avant chaque opération, gérer la révocation et journaliser le contexte effectif. Les chemins, liens symboliques et copies locales ne doivent pas donner accès à d'autres projets. Revoir les restrictions des modules existants pour conserver une politique cohérente, sans supprimer silencieusement une restriction déjà configurée. L'exécution SSH distante reste hors périmètre initial.

Recette : parcours agent → tâche → livrable, lecture seule par tous les canaux, perte d'accès, ressources incompatibles et branches simultanées sans interférence.

### PR 5 — Synchronisation et automatisations

Commencer par une copie à sens unique, déclenchée manuellement avec aperçu des changements. Ajouter source, destination, exclusions, identité d'exécution, traitement des conflits et journal de résultat. Désactiver la propagation des suppressions par défaut. Coordonner les transferts concurrents et rendre les reprises idempotentes.

Rattacher ensuite ces opérations au gestionnaire d'automatisations existant : planification et événements métier compatibles. Préserver les automatisations existantes et expliciter toute adaptation. Les opérations Git restent des opérations Git ; une copie de fichiers ne synchronise pas `.git`. La synchronisation bidirectionnelle est différée, hors de ce premier cycle de cinq PR.

Recette : aperçu conforme au transfert, conflits sans écrasement silencieux, suppression désactivée, retry sans duplication, révocation des accès, concurrence et historique d'exécution.

## Déploiement de la première PR

Sauvegarder ensemble la base et les volumes. Exécuter la migration avec une seule instance active, avant les automatisations. Une collision arrête le démarrage ; résoudre le conflit à partir de la sauvegarde, sans fusion automatique. Si une interruption survient après le renommage du dossier et avant la mise à jour de la base, le démarrage suivant reprend la transaction.

La migration v2 ne change pas encore les dossiers actifs, les secondaires ou les permissions des modules. Les protections des API de fichiers ne remplacent pas l'isolation des commandes exécutées directement sur le serveur. Consulter les [règles d'exploitation des workspaces](workspaces-projets.md) pour le retour arrière et les dossiers manquants.

## Mise en œuvre de la deuxième PR

La table `project_active_folders` stocke le type et l'identifiant du contexte, le projet, la ressource locale et le chemin relatif. Le service commun résout cette référence au moment de l'opération et expose les états `ready`, `detached`, `missing` et `invalid`. La référence à une ressource détachée est volontairement conservée afin de rendre le problème réparable.

Le rattrapage au démarrage reprend les chemins absolus des agents, tâches et livrables sans déplacer de fichiers. Il sélectionne uniquement une ressource du même projet contenant déjà le chemin. Le détachement d'un secondaire ne réaffecte aucune activité. Les vues de tâches et de livrables signalent les références qui demandent une correction, et les réponses de l'API exposent la ressource, le chemin relatif, le chemin effectif et l'état.

Les nouvelles opérations des agents résolvent d'abord la tâche liée, puis le défaut de l'agent. La navigation de l'explorateur demeure un état d'interface indépendant. Les ressources distantes, copies locales et transferts restent dans les PR 3 à 5.

## Mise en œuvre de la troisième PR

La table `project_workspace_resources` sépare désormais la définition d'une ressource de son éventuel dossier local. Les workspaces existants sont exposés comme ressources `local` de compatibilité avec le même identifiant. Les nouvelles ressources `git`, `ssh`, `sftp`, `ftp` et `ftps` stockent leur adresse, leur racine autorisée, leur mode d'accès, leurs capacités et leur état de connexion. Aucune ressource distante ne possède la capacité d'exécution ; une connexion SSH ne permet donc pas de lancer une commande distante.

Les secrets de connexion sont chiffrés avec AES-256-GCM dans une table séparée. La clé provient de `WEBUI_CONNECTION_SECRET_KEY`, avec `WEBUI_API_KEY` comme repli pour préserver les installations existantes. L'API ne renvoie jamais les identifiants : elle expose seulement `hasSecret`. Changer la clé sans réenregistrer les secrets les rend illisibles.

La gestion des connexions est réservée aux administrateurs, tandis que les participants du projet peuvent consulter les définitions et leurs états. L'écran des workspaces permet l'ajout, le test, l'activation, la désactivation et le détachement. Le détachement supprime uniquement la définition et son secret local ; il ne supprime aucune donnée distante. Le FTP non chiffré exige une option explicite. Les tests SSH/SFTP vérifient la bannière du serveur sans authentification ni commande, Git utilise `git ls-remote`, FTP peut vérifier la connexion et l'authentification, et FTPS vérifie la session TLS.

Cette étape ne transforme pas encore une ressource distante en dossier actif et ne copie aucun contenu. L'utilisation par les agents, les tâches et les livrables, ainsi que les copies de travail Git, appartient à la PR 4.

## Mise en œuvre de la quatrième PR

La table `project_workspace_copies` relie une ressource Git à une copie locale distincte. Chaque création clone le dépôt dans `sources/.external/<ressource>/<copie>` du workspace principal et mémorise la branche ainsi que la révision exacte. Deux activités travaillant sur des branches différentes possèdent donc des répertoires et des index Git indépendants. Une ressource SSH, SFTP, FTP ou FTPS ne peut pas devenir un dossier d'exécution : sa matérialisation passera par le transfert explicite de la PR 5.

Une activité choisit l'identifiant de la copie locale comme dossier actif. Le serveur refuse la sélection directe d'une ressource distante, vérifie à nouveau la ressource source au début de chaque opération et expose l'état `revoked` si elle a été désactivée ou détachée. La suppression d'une copie efface uniquement son clone local ; le dépôt distant et les références des activités sont conservés afin que l'état à réparer reste visible.

Le mode d'accès de la source s'applique à tous les nouveaux tours. Une copie issue d'une ressource en lecture seule force la politique Codex `readOnly`, empêche l'ajout de racines modifiables dans l'interface et ne peut pas être requalifiée en écriture par une option de conversation. Chaque démarrage de thread ou de tour journalise le workspace local, la ressource source, la révision Git et le mode effectif. L'exécution SSH distante et la synchronisation automatique restent exclues.

## Mise en œuvre de la cinquième PR

Une règle de transfert décrit une source, un workspace local de destination, leurs sous-dossiers, les exclusions, la politique de conflit et l'éventuelle propagation des suppressions. Elle ne déclenche aucune copie à sa création. L'administrateur produit d'abord un aperçu persistant qui classe chaque fichier en création, mise à jour, conflit, suppression ou absence de changement. `.git`, `.mergeron` et les liens symboliques sont toujours exclus du transfert.

L'exécution exige l'identifiant de cet aperçu et vérifie les empreintes de la source et de la destination avant chaque modification. Les écritures utilisent un fichier temporaire puis un renommage. Une nouvelle exécution du même résultat terminé est idempotente ; une reprise après erreur accepte les fichiers déjà copiés et refuse un fichier modifié depuis l'aperçu. Deux transferts ne peuvent pas écrire simultanément dans la même destination. Les suppressions restent désactivées par défaut et un conflit conservé apparaît explicitement dans le résultat.

Les ressources locales et les copies Git sont lues directement. SFTP, FTP et FTPS sont préparés dans un instantané local avant l'aperçu ; les secrets restent dans un fichier de configuration temporaire inaccessible aux agents et ne figurent pas dans la ligne de commande. SFTP peut recevoir une ligne `known_hosts` chiffrée avec les autres secrets afin de vérifier l'hôte. SSH ne permet toujours aucune commande distante et un dépôt Git distant doit d'abord posséder une copie de travail.

Le gestionnaire d'automatisations accepte une règle de transfert comme cible. Une exécution d'analyse produit uniquement l'aperçu. Une action soumise à validation applique exactement cet aperçu après approbation ; une règle explicitement configurée sans approbation peut l'appliquer durant l'exécution planifiée. Chaque aperçu, succès, conflit et échec est conservé dans l'historique du transfert et dans l'activité du projet.
