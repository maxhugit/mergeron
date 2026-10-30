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
- le fichier `.env` de production, hors du dépôt public ;
- les données OnlyOffice ou HA-MCP si elles doivent aussi être reconstruites.

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

La politique est globale et déterminée par l’environnement déclaré de la pile,
pas par l’agent ni par le composant mis à jour :

- **Dev — `development-none-v1`** : aucune copie de données, aucun inventaire
  récursif préalable, aucun calcul d’espace nécessaire à une sauvegarde. Les
  contrôles de santé restent obligatoires. Le retour arrière remet uniquement
  les images ; les données et migrations restent dans leur état courant et
  peuvent être incompatibles avec l’ancienne image. La confirmation le précise.
- **Production — `production-essential-v1`** : copie cohérente de `home`,
  `workspace`, `ssh`, `config` et des trois fichiers secrets. La base et ses
  journaux SQLite, conversations, documents, versions, brouillons, connaissances
  et travail Git local non publié restent conservés. Le dossier `logs` est exclu.

En production, seuls les répertoires régénérables identifiés sont écartés :
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
pas supprimées par ce changement. Les nouvelles mises à jour Dev ne déclenchent
pas leur rétention automatique puisqu’elles ne créent plus de sauvegarde.

Ces règles concernent les mises à jour du Manager. Elles ne désactivent pas les
sauvegardes externes de l’administrateur, ni ne les remplacent en cas de perte du
serveur ; `/appdata` nécessite toujours une stratégie externe adaptée.

## Sauvegarde cohérente

Pour une sauvegarde complète de la base SQLite, arrêter brièvement le conteneur
applicatif ou utiliser un outil compatible avec la sauvegarde SQLite en ligne.
Une copie brute pendant une écriture peut être incohérente.

Procédure prudente :

```bash
cd /srv/mergeron
docker compose --env-file .env -f compose.yml stop mergeron-ui
# lancer ici la sauvegarde de STATE_ROOT
docker compose --env-file .env -f compose.yml start mergeron-ui
```

## Restauration après perte du serveur

1. réinstaller Docker et le reverse proxy choisi, ainsi que le fournisseur
   d’identité si vous en utilisez un ;
2. cloner ce dépôt et préparer `mergeron/images.env` ;
3. restaurer `STATE_ROOT` aux chemins indiqués dans `.env` ;
4. restaurer les permissions des secrets et des clés SSH ;
5. recréer le réseau externe portant le nom enregistré dans
   `MERGERON_PROXY_NETWORK` et restaurer la route du proxy HTTPS ;
6. démarrer les trois services ;
7. exécuter la liste de tests du guide d’installation.

Si aucune sauvegarde n’existe, recréer les secrets et recommencer les connexions
OpenAI, MCP, GitHub et SSH. Les anciennes conversations et préférences seront
alors perdues.

## Test de restauration

Une sauvegarde n’est fiable qu’après un test. Au minimum une fois par trimestre,
restaurer dans un dossier temporaire isolé, démarrer avec un nom de projet et des
réseaux différents, puis vérifier la base SQLite et les espaces de travail sans
publier le service sur Internet.
