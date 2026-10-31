# Sauvegarde et restauration

Pour transférer ou conserver un projet isolé, utiliser aussi
l’[export/import ZIP des projets](export-import-projets.md). Ce ZIP ne contient
pas les comptes ni la configuration globale et ne remplace pas la sauvegarde
complète décrite ci-dessous.

## Éléments indispensables

Sauvegarder régulièrement :

- `STATE_ROOT/home` ;
- `STATE_ROOT/workspace` ;
- `STATE_ROOT/ssh` dans une archive chiffrée ;
- `STATE_ROOT/backend-token.txt` et `backend-token-nginx.txt` ;
- `STATE_ROOT/openai-api-key.txt` dans un coffre à secrets ;
- le fichier privé `manager.env` et la définition de lancement du Manager ;
- les données des services facultatifs, avec leurs propres outils de sauvegarde.

Les images Docker, journaux et caches peuvent être recréés. Sauvegarder aussi
les dossiers hôtes exposés via `/appdata`, avec l’outil de sauvegarde de votre
choix ; aucun plugin de panneau d’administration n’est requis.

### La base seule ne contient pas tous les fichiers

SQLite conserve notamment les fiches, associations, chemins et métadonnées de
versions. Les documents courants, leurs instantanés historiques et une partie
des historiques Codex sont des fichiers séparés. Sauvegarder également les
espaces système sous `workspace/.mergeron-system/` et les brouillons privés,
ainsi que le travail Git non publié, y compris les commits uniquement locaux.
Une base restaurée sans ces fichiers peut référencer des documents inexistants.

## Politique des mises à jour du Manager

### Format des nouvelles sauvegardes

Lorsqu’une mise à jour inclut une sauvegarde, le Manager crée désormais une
archive standard **tar + gzip** :
`STATE_ROOT/manager-state/updates/<transaction>/backup/backup.tar.gz`.
Le choix du périmètre ci-dessous ne change pas. **Aucune sauvegarde** ne crée
toujours ni archive ni inventaire récursif des données.

La compression utilise le niveau rapide de gzip et fonctionne en flux : aucun
chargement complet en RAM ni copie non compressée intermédiaire des données.
L’archive est écrite dans un fichier temporaire exclusif, synchronisée sur disque,
avec des synchronisations intermédiaires bornant les écritures sales en mémoire,
relue pour vérifier son SHA-256, puis publiée par renommage durable. La transaction
n’annonce la sauvegarde complète qu’après ces étapes, avant de remplacer les
conteneurs. Un échec laisse les données actives intactes et remet les anciens
conteneurs en marche.

L’archive conserve les chemins Unicode, les permissions Unix ordinaires, les
UID/GID, les dates et les liens, sans suivre les liens symboliques. Les fichiers
spéciaux non pris en charge sont refusés et les sockets transitoires ignorés,
comme précédemment. La taille affichée est celle du fichier **compressé**, pas
une estimation de son contenu décompressé. Le gain dépend des données : des
documents déjà compressés peuvent peu diminuer, voire légèrement grossir.

La compression n’est pas un chiffrement. L’archive reste privée (`0600`) sous
un dossier du Manager réservé (`0700`) ; elle peut contenir des secrets.
La rétention et les confirmations de suppression restent inchangées.

### Restauration et compatibilité

Le journal enregistre le format `tar-gzip-v1`, les tailles, le nombre d’entrées
et le SHA-256. Avant de toucher aux données actives ou aux conteneurs sains, la
restauration décompresse dans un espace privé temporaire, vérifie le flux complet,
ses limites et son empreinte, puis contrôle le périmètre enregistré. Elle refuse
notamment les chemins absolus ou traversants, les doublons, les écritures sous
un lien symbolique et les types de fichiers interdits.

Le mécanisme existant de préparation durable, de remplacement et de quarantaine
s’applique ensuite aux éléments validés. Une reprise après interruption recrée
l’entrée temporaire depuis l’archive ; une extraction partielle n’est jamais
acceptée comme une sauvegarde complète. Le temporaire est supprimé ensuite.
L’espace libre est vérifié sans supposer un taux de compression favorable :
une restauration doit pouvoir accueillir les fichiers décompressés et leur
préparation. Les protections Linux restent actives, sans nouveau privilège.

Les anciennes sauvegardes en répertoires restent lisibles et restaurables ; elles
ne sont ni converties ni réécrites automatiquement. Leur éventuelle suppression
suit toujours la rétention configurée, pas une migration de format. Un journal
qui annonce un format inconnu bloque la restauration, sans repli implicite vers
un répertoire. Utiliser un Manager prenant en charge ce format pour restaurer
une nouvelle archive, y compris lors d’un retour à une ancienne application.

### Choix du périmètre

Dans **Serveur → Mise à jour**, le champ **Sauvegarde avant cette mise à jour**
propose trois options en Dev comme en production. Le choix concerne la pile
ouverte, jamais l’autre environnement. Il s’applique aussi à une mise à jour
individuelle de conteneur. L’interface sélectionne **Complète** par défaut ; le
choix est figé dans le plan à confirmer puis enregistré dans la transaction.

| Option                                              | Copié avant la mise à jour                                                                                                                                                                                       | Retour arrière                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Complète** (`full-v1`)                            | Toutes les racines persistantes gérées : `home`, `workspace`, `logs`, `ssh`, `config` et secrets, y compris fichiers de projets, conversations, livrables, versions, brouillons et caches.                       | Anciennes images et toutes ces racines.                                                                                                 |
| **Minimale — base et configuration** (`minimal-v1`) | Base SQLite entière et fichiers `-wal`, `-shm`, `-journal` présents ; configuration et authentification Codex, instructions globales, catalogue de modèles, `.gitconfig`, `ssh`, `config` et secrets de la pile. | Anciennes images et uniquement les éléments sauvegardés. Les fichiers exclus restent dans leur état courant.                            |
| **Aucune sauvegarde** (`none-v1`)                   | Aucune copie ni inventaire récursif préalable des données.                                                                                                                                                       | Images uniquement. Les migrations et modifications de données restent appliquées, sans garantie de compatibilité avec l’ancienne image. |

Les contrôles de santé et d’identité des conteneurs restent obligatoires dans
les trois modes. Le mode rapide Dev ne change pas le périmètre de sauvegarde.
Le mode sans sauvegarde exige la confirmation explicite affichée avant l’arrêt.
Les montages externes `/appdata` restent hors périmètre dans tous les modes.

### Périmètre et limites du mode minimal

La base entière conserve aussi ses métadonnées de projets/livrables et certains
messages de chat simple : le mode minimal n’est **pas** un export sélectif de
tables. En revanche, aucun fichier de `workspace`, aucun historique Codex de
`sessions`/`archived_sessions`, aucun document/version de livrable ni brouillon
de projet n’est copié. Une base restaurée peut donc ne plus correspondre aux
fichiers exclus. L’interface l’indique avant mise à jour et avant restauration.

Le Manager déduit les chemins de `CODEX_HOME` et `WEBUI_DB_PATH` du conteneur
applicatif. Ils doivent rester sous `/home/codex`, sans `..` ni ancêtre
symbolique. La base doit exister. Seuls les fichiers explicitement sélectionnés
sont copiés : `config.toml`, `auth.json`, `AGENTS.md`, `webui/model-catalog`,
`.gitconfig` et la base avec ses fichiers compagnons. Il ne copie jamais
`CODEX_HOME` ou `webui` en entier dans ce mode.

La restauration minimale conserve les données remplacées en quarantaine et
retire aussi un fichier compagnon SQLite créé après une sauvegarde où il était
absent. Elle préserve les permissions des répertoires parents privés ; leurs
métadonnées sont journalisées avant tout ajustement temporaire de propriété.
Le périmètre de restauration est validé contre la configuration enregistrée,
jamais accepté comme une liste de chemins arbitraire.

### API et compatibilité des anciennes opérations

`POST /v1/update/plan` accepte `backupMode: "full" | "minimal" | "none"`,
indépendamment de `mode: "standard" | "dev-fast"`. Le même `backupMode` doit
être fourni à `POST /v1/update` avec l’empreinte et la confirmation du plan :
changer de choix invalide l’empreinte. La récupération utilise la politique
et le périmètre enregistrés, pas un réglage actuel ou un autre environnement.
La capacité `backupSelection` annonce ce contrat ; une interface connectée à
un ancien Manager n’affiche pas de choix qu’il ne saurait appliquer.

Pour compatibilité, un appel **sans** `backupMode` conserve les anciens défauts :

- **Dev — `development-none-v1`** : aucune copie de données, aucun inventaire
  récursif préalable, aucun calcul d’espace nécessaire à une sauvegarde. Les
  contrôles de santé restent obligatoires. Le retour arrière remet uniquement
  les images ; les données et migrations restent dans leur état courant et
  peuvent être incompatibles avec l’ancienne image. La confirmation le précise.
- **Production — `production-essential-v1`** : copie cohérente de `home`,
  `workspace`, `ssh`, `config` et des trois fichiers secrets. La base et ses
  journaux SQLite, conversations, documents, versions, brouillons, connaissances
  et travail Git local non publié restent conservés. Le dossier `logs` est exclu.

Dans l’ancienne politique `production-essential-v1` seulement, les répertoires
régénérables identifiés suivants sont écartés :
`home/.cache`, `home/.npm`, `home/.pnpm-store`, `home/.yarn/cache`,
`home/.local/share/pnpm/store` ; dans les sources, `node_modules`, `.build-cache`,
`.pnpm-store`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache` et `__pycache__`.
Les instantanés techniques `workspace/.mergeron-system/<id>/previews` sont recréables.
Les documents/livrables, historiques système et brouillons protégés ne sont pas
filtrés par ces noms, y compris dans les anciennes structures avant migration.
Les dossiers génériques `dist` et `build` ne sont pas exclus aveuglément : un
projet peut y conserver des fichiers manuels. Les liens sont copiés sans être suivis.

Le calcul de place disponible applique exactement le même filtre que la copie.
La restauration remet les racines incluses depuis la sauvegarde filtrée ; les
caches/dépendances manquants doivent être régénérés. Les racines exclues telles
que `logs` restent inchangées. Les données plus récentes des racines restaurées
sont conservées en quarantaine, pas écrasées sans conservation.

Chaque transaction journalise sa politique avant toute interruption. Une reprise
utilise cette politique, pas les nouveaux réglages. Un ancien journal sans ce
champ reste une sauvegarde complète historique, restaurée comme telle ; une
politique inconnue bloque la récupération. Les anciennes sauvegardes ne sont
pas supprimées par ce changement. La rétention configurée s’applique après une
mise à jour réussie ayant créé une sauvegarde, en Dev comme en production.

Ces règles concernent les mises à jour du Manager. Elles ne désactivent pas les
sauvegardes externes de l’administrateur, ni ne les remplacent en cas de perte du
serveur ; `/appdata` nécessite toujours une stratégie externe adaptée.

## Sauvegarde cohérente

Pour une sauvegarde complète de la base SQLite, arrêter brièvement le conteneur
applicatif ou utiliser un outil compatible avec la sauvegarde SQLite en ligne.
Une copie brute pendant une écriture peut être incohérente.

Procédure prudente :

```bash
docker stop mergeron-ui
# lancer ici la sauvegarde de STATE_ROOT
docker start mergeron-ui
```

## Restauration après perte du serveur

1. réinstaller Docker et le reverse proxy choisi, ainsi que le fournisseur
   d’identité si vous en utilisez un ;
2. préparer la définition du Manager et son fichier privé `manager.env` ;
3. restaurer la racine persistante aux mêmes chemins hôtes ;
4. restaurer les permissions des secrets et des clés SSH ;
5. recréer le réseau externe portant le nom enregistré dans
   `MERGERON_PROXY_NETWORK` et restaurer la route du proxy HTTPS ;
6. démarrer le Manager selon le [guide](installation.md), avec les images et
   réglages sauvegardés, pour recréer les dépendances manquantes ;
7. exécuter la liste de tests du guide d’installation.

L’empreinte d’adoption peut contenir des identifiants Docker propres à l’hôte
perdu. Une différence bloque la gestion automatique : arrêter la procédure
et faire vérifier le plan de reprise par l’administrateur, sans effacer
`adoption.json` pour contourner ce contrôle. Une installation neuve ne vaut
pas validation automatique d’une restauration.

Si aucune sauvegarde n’existe, recréer les secrets et recommencer les connexions
aux services externes utilisés. Les conversations et préférences seront
alors perdues.

## Test de restauration

Une sauvegarde n’est fiable qu’après un test. Au minimum une fois par trimestre,
restaurer dans un dossier temporaire isolé, démarrer avec un nom de projet et des
réseaux différents, puis vérifier la base SQLite et les espaces de travail sans
publier le service sur Internet.
