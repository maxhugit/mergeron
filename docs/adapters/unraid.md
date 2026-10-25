# Exploitation sur Unraid

> Archive du parcours manuel. Pour une installation neuve, privilégier le seul
> formulaire Manager décrit dans [l’adaptation actuelle](README.md). Les quatre
> formulaires et le réconciliateur ci-dessous ne concernent que la méthode
> manuelle historique, à ne pas cumuler avec la création par le Manager.

La plateforme comprend trois conteneurs applicatifs et Mergeron Manager en
observation. Pour une installation native dans l'onglet **Docker** d'Unraid,
utiliser les quatre formulaires de
[`deployment/docker-man`](../../deployment/docker-man) et suivre la
[procédure DockerMan](unraid-dockerman.md).

La définition [`deployment/compose.yml`](../../deployment/compose.yml)
reste disponible comme variante pour Compose Manager.

Avant une nouvelle installation ou un changement de méthode, consulter le
[comparatif DockerMan / Compose Manager](../choisir-mode-installation.md). Les
deux modes utilisent les mêmes données mais ne doivent pas fonctionner en même
temps.

| Mode            | À privilégier pour                                                           | Point d’attention                                                                                   |
| --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| DockerMan       | intégration native à l’onglet Docker et mises à jour conteneur par conteneur | le réconciliateur rattache les réseaux secondaires et doit être relancé après un redémarrage Unraid |
| Compose Manager | gestion déclarative et mise à jour des quatre services comme une stack       | les changements doivent être reportés dans `docker-compose.yml` ou `images.env`                     |

## Emplacements recommandés

```text
/mnt/pool/appdata/mergeron
  docker-compose.yml
  images.env
  config/
  state/
    home/
    workspace/
    logs/
    ssh/
    manager-run/
    manager-state/
    backend-token.txt
    backend-token-nginx.txt
    openai-api-key.txt
```

Les fichiers sous `state` ne doivent jamais être ajoutés au dépôt.

## Mise à jour recommandée

Avec les formulaires standard, utiliser **Docker > Check for Updates**, puis
**Update** sur `mergeron`. Unraid recrée le conteneur à partir de `latest`
sans toucher aux données persistantes de `state`.

Les trois conteneurs applicatifs restent nécessaires : Nginx porte
l'authentification et le routage entrant, tandis que Squid contrôle les accès
Internet sortants. Le Manager observe leur santé sans réseau ni port publié.

Dans ce mode, le formulaire de chaque conteneur est sa configuration de référence.
Mettre à jour `mergeron` ne recrée pas automatiquement Nginx ou Squid. Leurs
images sont vérifiées et mises à jour séparément depuis l’onglet **Docker**.

DockerMan recrée un conteneur avec un seul réseau de démarrage. Le
réconciliateur lancé depuis l'Appdata rétablit automatiquement les réseaux
secondaires après une mise à jour, sans modifier la clé USB. Il doit être
relancé après un redémarrage complet d'Unraid. Compose Manager gère nativement
ces réseaux et ne nécessite pas ce processus complémentaire.

## Variante Compose Manager

Dans ce mode, `docker-compose.yml` décrit la topologie et `images.env` choisit
les images et les chemins de l’hôte. Modifier directement un conteneur créé par
Compose sans reporter le changement dans ces fichiers n’est pas durable.

### Commandes d'exploitation

```bash
cd /mnt/pool/appdata/mergeron
docker compose --env-file images.env -f docker-compose.yml ps
docker compose --env-file images.env -f docker-compose.yml pull
docker compose --env-file images.env -f docker-compose.yml up -d
```

### Gestion depuis l'interface Unraid

La stack est prévue pour le plugin **Compose Manager**. Les labels
`net.unraid.docker.*` donnent aux conteneurs une icône, un terminal et, pour
l’application principale, un lien vers l’interface Web.

Dans **Docker > Compose**, la stack permet de :

- modifier le fichier Compose ;
- modifier le fichier d’environnement et le tag `MERGERON_APP_IMAGE` ;
- démarrer ou arrêter les quatre conteneurs ensemble ;
- utiliser **Update Stack** pour télécharger les images et recréer les quatre
  conteneurs dans le bon ordre.

Ne pas mélanger les conteneurs de cette stack avec ceux créés depuis les
formulaires DockerMan : ils ont volontairement les mêmes noms.

La procédure d’installation et de restauration complète est disponible dans
[`docs/adapters/unraid-compose.md`](unraid-compose.md).

L’architecture et les responsabilités des conteneurs sont décrites dans
[`docs/architecture.md`](../architecture.md).
