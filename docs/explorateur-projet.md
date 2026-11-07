# Explorateur du projet : Dossiers, Livrables et Sources

[← Documentation](README.md)

L’explorateur présente trois vues du même projet. Changer de vue ou parcourir un
répertoire ne change pas le dossier de référence de l’agent.

- **Dossiers** conserve l’explorateur habituel : création de fichiers et de
  répertoires, import, déplacement, renommage et consultation. Le répertoire
  principal est `dossiers/`. Les autres connexions locales restent sélectionnables.
- **Livrables** présente les livrables par leur titre, leurs documents et leurs
  actions habituelles (détails, documents, historique, validation, tâche principale,
  suppression). Déplier un livrable affiche ses documents enregistrés avec leur version courante
  (V1, V2…). Cette liste ne propose ni navigation dans le système de fichiers ni
  création de dossiers. Les dossiers virtuels par étiquettes restent disponibles,
  ainsi que les actions versionnées propres à chaque document.
  Créer, déposer, enregistrer ou renommer un document dans cette vue passe par
  le gestionnaire de livrables : le fichier devient un document du livrable,
  avec son identité, ses versions et ses contrôles de concurrence.
- **Sources** conserve les connexions Git, leurs copies locales et les actions
  Git existantes. Une connexion et sa copie sont des objets distincts.
  Sans copie locale propre à l’agent, un message explique comment en préparer une
  depuis le menu de la source. Aucun explorateur des racines du serveur n’est
  affiché par défaut dans cette vue. Si une copie est déjà disponible, le message
  invite à sélectionner sa source, sans changer automatiquement la référence.

L’action **Utiliser comme référence de l’agent** se trouve dans le menu contextuel
ou le menu d’actions du dossier, du livrable ou de la source Git. La référence est
mémorisée côté serveur pour la conversation. Parcourir les fichiers ne sélectionne
jamais implicitement une nouvelle référence. Un chemin indisponible ou interdit
reste refusé ; choisir une référence ne donne aucun droit supplémentaire.

## Organisation physique, version 4

Dans l’onglet **Dossiers**, la remontée s’arrête à la racine affichée du dossier
du projet. Le bouton de remontée y est désactivé ; les sous-dossiers restent navigables.

```text
/workspaces/<projet>/
├── AGENTS.md
├── dossiers/                         # Organisation libre de l’utilisateur
├── .mergeron-agent-drafts/            # Préparation des documents des agents
│   └── <empreinte-conversation>/<tour>/
└── .mergeron-system/
    ├── project.json                  # Identité et version de l’organisation
    ├── layout-v4.json                # Journal de migration, s’il y en a eu une
    ├── knowledge/                    # Connaissances et décisions
    ├── history/                      # Versions et historiques conservés
    ├── livrables/<livrable>/          # Documents courants, identités en base
    ├── sources/<connexion>/copies/<copie>/
    │                                # Dépôts Git autonomes, inchangés
    └── operations/                   # Archives techniques de migration
```

Les anciens fichiers et dossiers libres du projet sont conservés dans `dossiers/`,
y compris les dossiers cachés. Voir un dossier nommé `.aws` ou `.codex` à cet
endroit ne signifie pas qu’il s’agit du répertoire système du serveur : il peut
s’agir d’un ancien dossier du projet préservé par la migration. Son accès reste
soumis aux contrôles habituels, dès la création de l’agent.

Les connexions secondaires externes conservent leur emplacement : elles ne sont
pas déplacées dans le projet. Le niveau `.external` n’existe plus dans la nouvelle
organisation des copies Git. Les identifiants des connexions, copies, livrables,
documents et conversations sont conservés pendant une migration.

## Migration et reprise

Au démarrage, `ProjectWorkspaceLayout` termine d’abord les anciennes migrations
(v1–v3), puis applique `migrateManagedProject` :

1. Vérification du propriétaire du projet, des sources, des destinations et des
   répertoires. Une collision, un lien symbolique au niveau d’une racine déplacée
   ou un transfert actif bloque l’opération avant les déplacements.
2. Déplacement par renommage sur le même volume, sans fusion ni écrasement :
   l’ancien espace système et les brouillons deviennent des enfants du projet ;
   `documents/` devient `dossiers/`, `livrables/` rejoint l’espace système et
   `sources/.external/<connexion>/` devient `sources/<connexion>/copies/` dans
   l’espace système. Les autres fichiers utilisateur sont conservés dans Dossiers.
   Les restes libres de l’ancien répertoire `sources/` deviennent
   `dossiers/sources-importees/`.
3. Enregistrement d’un point de reprise après chaque renommage. Le journal reste
   dans l’espace système et n’est pas exposé dans Dossiers. Une interruption
   avant la transaction en base permet de reprendre les déplacements déjà faits.
4. Mise à jour transactionnelle des chemins typés en base, des références de
   dossiers et des liens documentaires. Les chemins de conversation mémorisés et
   les racines explicites du bac à sable sont relocalisés sans modifier les choix
   de modèle, d’effort, d’approbation ou d’accès. Les anciens chemins de documents restent
   des alias ; aucun lien symbolique n’est créé pour les rendre accessibles.

Les copies Git autonomes sont déplacées sans checkout, reset, stash ni nettoyage :
HEAD, index, modifications non enregistrées et fichiers non suivis restent intacts.
Un worktree Git lié à un dépôt extérieur bloque la migration avec un diagnostic ;
il faut d’abord le rendre autonome. Aucun déplacement partiel n’est entrepris dans
ce cas. Une collision exige une intervention de l’administrateur ; il ne faut pas
supprimer le journal ni fusionner les répertoires à l’aveugle.

Les instructions `AGENTS.md` personnalisées restent inchangées. Seul le texte
exact généré par Mergeron peut être remplacé. Les exports ZIP incluent la nouvelle
organisation ; l’import recrée l’identité du projet et ne rejoue pas le journal de
migration du projet source. Les sauvegardes complètes conservent versions,
connaissances et brouillons, même si un sous-dossier porte un nom de cache.

La suppression d’un projet avec conservation de son dossier conserve également
les documents, copies Git, historiques et brouillons désormais placés sous cette
racine. Les fichiers d’une copie explicitement sélectionnée pour suppression
restent soumis à une vérification de propriété et à une mise en quarantaine.

## Protections

L’espace système n’est pas rendu accessible dans son ensemble. Le serveur autorise
seulement les projections documentaires enregistrées et les copies Git connues.
Les droits du projet et la confidentialité du livrable restent contrôlés, y compris
lorsqu’un fichier est demandé directement. Les écritures documentaires passent par
le gestionnaire de versions ; l’API générique ne peut pas remplacer un livrable ou
un historique. Les protections de finalisation, d’édition OnlyOffice, de suppression
récupérable, de concurrence et de révocation des connexions restent applicables.

Dans le bac à sable Linux, le répertoire système est masqué, puis seuls les
documents courants (lecture seule) et les copies Git enregistrées sont remontés.
Les profils natifs continuent à limiter l’écriture à la copie de l’agent et aux
racines autorisées. La sélection d’une référence ne contourne ni ces profils,
ni les restrictions réseau, ni la politique d’approbation. Les macros ne sont
jamais exécutées par cette fonctionnalité.

Les tests couvrent les anciens formats, le nouveau format, les collisions,
les liens symboliques, la reprise, les références, l’état Git, les opérations
métier sur les documents, le connecteur MCP et les trois vues. Le test Linux
`smoke-test-document-isolation.cjs` vérifie les montages et l’impossibilité de
modifier ou déplacer les documents protégés à travers un parent inscriptible.

Pour contrôler les références en base et les dossiers présents, utiliser
[Cohérence des projets](coherence-projets.md) dans les paramètres globaux.
