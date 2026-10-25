# Exporter et importer un projet

Cette fonction sert à transférer un projet, par exemple de production vers
development, et à conserver un instantané autonome pour un archivage ultérieur.
Elle ne remplace pas la [sauvegarde complète de l’installation](sauvegarde-restauration.md).

## Depuis l’interface

L’export et l’import sont réservés aux administrateurs : un projet peut contenir
des conversations privées, des documents restreints et des coordonnées personnelles.

1. Ouvrir le menu contextuel du projet dans la barre latérale (clic droit sur le
   projet ou bouton **Actions du projet**).
2. Choisir **Exporter tout le projet en ZIP**, puis confirmer dans la fenêtre d’export.
3. Sur l’autre installation, cliquer sur **+** dans la rubrique **Projets**, puis
   choisir **Importer un projet depuis un ZIP** dans la fenêtre de création.
   Aucun projet vide n’est nécessaire au préalable.
4. Sélectionner le ZIP. L’application vérifie l’inventaire, les empreintes des
   fichiers, les données liées et la compatibilité avec la destination.
5. Si l’analyse réussit, choisir les ensembles à importer dans la fenêtre,
   vérifier le nom du nouveau projet et confirmer. Tout est sélectionné par défaut.

### Sélection et dépendances

Les informations du projet, participants, groupes et configurations des espaces
de travail sont toujours inclus. Trois catégories volontairement larges sont proposées :

- **Fichiers et dossiers** : contenu de tous les espaces locaux, sans sélection fichier par fichier.
- **Agents et conversations** : discussions simples, agents, branches, historiques et pièces jointes.
  Cette catégorie inclut automatiquement les fichiers, nécessaires aux chemins et références des conversations.
- **Activité métier complète** : tâches, sous-tâches, dépendances, livrables, documents,
  versions, validations, automatisations, connaissances et journal. Ce bloc inclut
  automatiquement les deux catégories précédentes, afin de conserver les liens avec les agents et documents.

Les dépendances sont cochées et verrouillées tant qu’une catégorie sélectionnée
les utilise. Pour les retirer, décocher d’abord les catégories qui en dépendent.
Tout décocher crée uniquement la structure du projet et ses contacts inactifs,
sans fichiers, conversations ni activité métier. Les définitions des espaces
distants restent désactivées, comme pour un import complet.
La sélection est aussi appliquée côté serveur : envoyer uniquement le bloc métier
inclut malgré tout toutes ses dépendances. Les références sont revérifiées avant
toute restauration ; une incohérence bloque l’import sans publier de projet partiel.
L’archive complète doit rester compatible, même si certaines catégories ne sont
pas retenues. Le volume affiché reste celui du ZIP complet, pas une estimation filtrée.

L’import crée toujours une nouvelle identité de projet. Il ne fusionne pas les
données et ne remplace ni un projet existant, ni ses fichiers. Importer le même
ZIP une seconde fois crée volontairement une deuxième copie indépendante.
L’analyse reste valable quinze minutes et appartient à l’administrateur qui a
envoyé le fichier. La compatibilité est revérifiée à la confirmation.

## Contenu transporté

- Informations du projet, ressources et leur configuration, journal et connaissances.
- Participants et groupes sous forme de fiches de contact, chef de projet,
  affectations et noms des auteurs des événements historiques.
- Tableaux de tâches, états personnalisés, tâches, sous-tâches, dépendances et journal.
- Livrables, documents, versions historiques, compositions figées, validations
  et historique du cycle de vie ; archives de changements OnlyOffice conservées.
- Conversations simples et messages ; agents associés, branches, historique
  JSONL, index paginé, noms, compteurs, objectifs et mémoires propres aux agents.
- Fichiers des espaces locaux associés, dossiers vides et pièces jointes locales
  de conversation référencées par le projet.
- Définitions des ressources distantes, copies locales et règles/historiques de transfert.

Les identifiants et chemins opérationnels sont adaptés au nouveau projet. Les
espaces locaux imbriqués conservent leurs fichiers partagés, sans duplication.
Un espace secondaire englobant le principal est refusé avec une explication.
Les
historiques d’agents conservent leurs identifiants de tours/items, mais reçoivent
de nouveaux identifiants de conversation. Les index paginés sont recalculés en
fonction des nouveaux chemins et des nouvelles positions dans les fichiers JSONL.

## Sécurité d’un transfert production → development

Les mots de passe, identités SSO, sessions d’authentification, clés de fournisseur,
secrets SSH/FTP et jetons documentaires de l’installation ne sont pas transportés.
Les contacts deviennent des fiches **inactives**, sans droits d’administration
et sans association automatique à un compte déjà présent sur la destination.
Leurs coordonnées et propriétés d’origine restent dans la provenance du projet
(`project_archive_imports`), afin de ne pas perdre cette information lors de
collisions avec les comptes de destination. Les affectations et noms historiques
sont conservés. L’administrateur qui importe est ajouté comme participant.

Les automatisations sont désactivées, les objectifs actifs sont mis en pause,
les tâches d’agent en cours repassent en mode manuel et les connexions externes
sont désactivées. Les associations aux MCP/apps de production sont conservées
dans la provenance, pas activées sur la destination. Les politiques des agents
importés sont ramenées à la lecture seule avec approbation utilisateur.
**Aucun agent importé, modèle ou automatisation ne démarre pendant l’import.**

Les identifiants de connexion enregistrés séparément ne sont pas copiés, mais
un fichier `.env`, un document ou le texte d’une conversation peut lui-même
contenir un secret. Le ZIP **n’est pas chiffré**. Le conserver dans un stockage
protégé et n’importer que des archives dont on connaît la provenance.

Une connexion à un serveur distant n’est pas une copie de son contenu. Les
définitions sont incluses, mais le ZIP ne parcourt pas automatiquement les
serveurs SSH/SFTP/FTP/Git distants. Pour conserver leurs fichiers, créer d’abord
une copie locale associée au projet, puis exporter celle-ci.

Les processus actifs, terminaux en mémoire, demandes d’approbation en attente,
files d’exécution, préférences propres au navigateur et réglages globaux de la
plateforme ne constituent pas des données de projet restaurables. Ils ne sont
pas réactivés ou importés.

## Versions différentes : contrat de compatibilité

La compatibilité ne repose **pas** sur l’égalité de deux tags Mergeron. Le ZIP
contient un `manifest.json` avec :

- `kind: mergeron.project` et `formatVersion: 1` ;
- version productrice, date d’export et identité d’origine ;
- fonctionnalités requises (`requiredCapabilities`) ;
- sections structurées, description des colonnes et relations ;
- inventaire des fichiers, tailles et empreintes SHA-256 ;
- version et sections du moteur d’agents, s’il y en a.

Deux versions de Mergeron différentes sont acceptées si elles comprennent le
même contrat et les données présentes. Des colonnes supplémentaires sur la cible
sont compatibles lorsqu’elles sont facultatives ou ont une valeur par défaut.
Un champ source inconnu n’est jamais supprimé silencieusement.

En revanche, l’analyse refuse notamment un format plus récent, une fonctionnalité
requise inconnue, une section absente, un type de colonne incompatible, un nouveau
champ obligatoire sans valeur par défaut, une relation extérieure au ZIP ou une
version de document absente/altérée. Le message indique la section ou le champ
concerné. Une mise à jour du lecteur ou un convertisseur est alors nécessaire.

Les agents possèdent leur propre format de stockage, distinct de Mergeron.
Le premier codec est prévu pour **Codex 0.153.x**, vérifié avec **0.153.2**.
Les versions majeure et mineure des moteurs source et destination doivent
correspondre, et les structures réelles doivent rester compatibles. Une autre
génération du moteur ou une nouvelle base d’historique est refusée explicitement,
pas importée partiellement. Cela n’impose pas la même version de Mergeron.
Un projet sans agents n’a pas cette dépendance au moteur.

Sur une destination vide, les bases natives absentes sont initialisées par le
moteur installé, dans un home temporaire sans identifiants. Un tour interne fixe
`true` matérialise le schéma paginé ; aucun contenu du ZIP ni appel de modèle
n’est exécuté. Seules les structures natives vides et leurs migrations sont
installées, sans écraser une base existante. Les SQL/DDL d’un ZIP ne sont jamais
exécutés.

Pour faire évoluer ce contrat, ajouter un codec ou une migration explicite et
déclarer toute nouvelle fonctionnalité obligatoire. Un changement de signification
des données doit faire évoluer les capacités ou le format, même sans changement
de colonnes SQLite.

## Cohérence, limites et reprise

Attendre la fin des échanges d’agents, synchronisations et modifications de
documents avant l’export. Si les données ou fichiers changent pendant la copie,
l’export est refusé et le ZIP partiel supprimé.

Limites de cette première version : **96 Mio** par ZIP, **1 Gio** décompressé,
**256 Mio** par fichier, **20 000 fichiers**, **20 000 dossiers**, **64 Mio** de
métadonnées. Les ZIP chiffrés, liens symboliques/physiques, fichiers spéciaux,
chemins dangereux, noms ambigus entre systèmes et espaces Git dépendant d’un
dépôt extérieur sont refusés. Rien n’est ignoré silencieusement. Un clone Git
autonome sans liens peut être exporté ; les liens ne sont pas suivis vers des
données extérieures au projet.

L’envoi est temporaire, privé et supprimé après import, abandon ou expiration.
L’import prépare des dossiers privés, réserve de nouvelles identités, restaure
les données avec transactions SQLite et ne publie le projet qu’à la fin. Un
journal durable permet de nettoyer les imports non publiés après interruption.
La compensation ne supprime que les fichiers/identités créés par cet import,
avec vérification de leur propriété ; les volumes de fichiers et d’état peuvent
être distincts. Les noms d’agents sont ajoutés à l’index natif append-only, sans
réécrire les noms existants. Après un échec, cet index peut conserver une entrée
pour un nouvel identifiant sans historique, comme après une suppression native ;
elle ne constitue pas un agent restauré et n’est pas affichée.

## Validation développeur

```bash
python3 -m unittest discover -s scripts -p test_project_archive.py
pnpm exec vitest run src/projects/project-archives.spec.ts
pnpm --dir web exec vitest run --project unit src/components/projects/project-archive-transfer.spec.tsx
pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/project-archive.ts
ARCHIVE_PROBE_ARCHIVED=1 pnpm exec ts-node --project codex_probe/tsconfig.json codex_probe/project-archive.ts
```

Le dernier essai utilise le vrai binaire épinglé dans des dossiers temporaires et
un faux fournisseur local qui refuse la génération. Il vérifie la redécouverte,
la lecture des items paginés et la reprise manuelle en lecture seule, sans compte
réel, transfert de données réelles ou appel payant. Un échec conserve uniquement
son jeu de données artificiel pour diagnostic.
