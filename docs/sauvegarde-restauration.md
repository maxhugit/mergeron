# Sauvegarde et restauration

## Éléments indispensables

Sauvegarder régulièrement :

- `STATE_ROOT/home` ;
- `STATE_ROOT/workspace` ;
- `STATE_ROOT/ssh` dans une archive chiffrée ;
- `STATE_ROOT/backend-token.txt` et `backend-token-nginx.txt` ;
- `STATE_ROOT/openai-api-key.txt` dans un coffre à secrets ;
- le fichier `.env` de production, hors du dépôt public ;
- les données OnlyOffice ou HA-MCP si elles doivent aussi être reconstruites.

Les images Docker, journaux et caches peuvent être recréés. `/appdata` est
normalement couvert par le plugin de sauvegarde Appdata d’Unraid.

## Sauvegarde cohérente

Pour une sauvegarde complète de la base SQLite, arrêter brièvement le conteneur
applicatif ou utiliser un outil compatible avec la sauvegarde SQLite en ligne.
Une copie brute pendant une écriture peut être incohérente.

Procédure prudente :

```bash
cd /mnt/user/appdata/mergeron
docker compose --env-file images.env -f docker-compose.yml stop app-v4
# lancer ici la sauvegarde de STATE_ROOT
docker compose --env-file images.env -f docker-compose.yml start app-v4
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
