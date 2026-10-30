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

La sauvegarde transactionnelle actuelle du [Manager](mergeron-manager.md) est
une copie complète de ses racines déclarées, incluant `home`, `workspace`,
`logs`, `ssh`, `config` et les fichiers secrets. Elle ne filtre pas encore les
dépendances ou compilations présentes dans les dossiers des agents. L’inventaire
préalable et les copies durables par fichier peuvent donc prendre longtemps,
même avec peu de données métier et des disques rapides. Le mode dev rapide
borne la concurrence, mais reste une sauvegarde complète, pas incrémentale.

Ne pas supprimer des dossiers ni ajouter des exclusions au milieu d’une
transaction. Une politique ciblée distinguant données irremplaçables et caches
régénérables doit être testée avec la restauration avant de remplacer ce circuit.
Cette sauvegarde de mise à jour ne remplace pas la stratégie externe de reprise
après perte du serveur.

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
