# Compétences optionnelles du serveur

Dans **Paramètres → Serveur → Compétences**, un administrateur peut installer ou désinstaller **Navigation web** et **Transcription**. Le catalogue porte sur des fonctionnalités, pas sur des conteneurs Docker arbitraires.

## Fonctionnement

- Une nouvelle installation ne télécharge ni ne crée ces conteneurs. Les paramètres historiques restent désactivés par défaut.
- Lors de la première migration, les compagnons présents sont conservés. Une configuration historique activant explicitement la transcription reste reconnue. Aucun conteneur existant n'est supprimé par cette migration.
- « Installée — démarrage à la demande » signifie que le service est installé et au repos. Ce n'est pas une panne. Un conteneur manquant ou mal isolé reste une erreur, même si l'intention d'installation est enregistrée.
- Installer demande une confirmation puis télécharge une image du dépôt approuvé sur le canal de l'environnement (`edge` en développement, `latest` en production). Le navigateur reste au repos jusqu'à utilisation ; la transcription peut être démarrée pendant sa préparation puis arrêtée par son délai d'inactivité.
- Désinstaller demande une confirmation et refuse un service utilisé. Seul le conteneur vérifié de la stack est arrêté puis supprimé. Les documents, résultats conservés, images Docker et réseaux sont gardés. Aucune suppression de volume n'est demandée.
- Le choix du navigateur isolé est indisponible quand la compétence n'est pas installée. Le navigateur local par extension reste indépendant. Les traitements audio sont désactivés quand la transcription n'est pas installée ; les résultats existants restent consultables.
- Installer ne donne aucune permission supplémentaire aux agents. Les contrôles d'identité, d'approbation et de sandbox continuent de s'appliquer. Les appels directs ne peuvent pas contourner l'absence de compétence.
- Les compétences installées rejoignent les mécanismes existants de démarrage à la demande et de mise à jour. Les compétences absentes ne sont pas ajoutées au plan global.

## API et état du Manager

Le navigateur contacte les routes administrateur `GET /api/settings/manager/capabilities` et `POST /api/settings/manager/capabilities`. Le serveur les transmet par socket Unix à `/v1/capabilities`. L'authentification et le contrôle administrateur de `/settings` restent obligatoires.

Une mutation n'accepte que :

```json
{ "id": "browser", "action": "install", "confirmation": "install:browser" }
```

Identifiants : `browser`, `transcription`. Actions : `install`, `uninstall`. La confirmation reprend exactement `<action>:<id>`. Images, commandes, montages, réseaux et identités ne sont pas des paramètres de cette API.

La réponse contient `capabilities` (`id`, `installed`, `state`, `activeLeases`), `operation` et `error`. L'opération est asynchrone ; la page relit son état toutes les cinq secondes. Une erreur ne signifie pas une installation réussie et ne déclenche pas de nouvelle tentative automatique.

Le fichier privé `capabilities.json`, à côté du registre d'adoption du Manager, conserve l'intention d'installation et une opération interrompue. L'écriture se fait par fichier temporaire puis renommage. Après redémarrage, une opération interrompue est signalée et nécessite une nouvelle action explicite. L'état enregistré prend le pas sur les anciennes variables d'activation après migration.

Le Manager vérifie le socle adopté avant toute mutation. La réécriture du registre d'adoption compare les identités, images, montages et réseaux du socle avant/après ; seule l'association au réseau de contrôle du navigateur est autorisée à changer. Une dérive d'un autre composant n'est jamais validée par l'installation d'une compétence.

## Isolation

Le navigateur conserve l'utilisateur `pwuser`, le système de fichiers en lecture seule, aucune capability Linux, `no-new-privileges`, le profil seccomp fourni, les DNS publics imposés, deux réseaux dédiés dont le contrôle interne, des limites de ressources, aucun port publié et aucun montage de données. L'application rejoint uniquement le réseau de contrôle.

L'adresse WebSocket et son secret sont transmis à l'application dans une réponse de bail sur la socket Unix. Ils ne sont pas inclus dans le catalogue public ni dans la réponse de préparation du navigateur à l'interface. Aucun redémarrage de l'application n'est nécessaire pour apprendre cette adresse.

La transcription réutilise le constructeur CPU isolé existant et sa vérification d'appartenance. Les opérations de compétence sont exclusives avec les mises à jour, installations et traitements gérés. La suppression Docker utilise `force=false` et `v=false`, après une seconde vérification de l'identité du conteneur arrêté.

## Ajouter une compétence : procédure de contribution

Le point d'entrée est le **catalogue versionné** `manager/src/capability-catalog.mjs`. Le moteur de cycle de vie et l'interface parcourent ce catalogue : ils ne déduisent pas le nom ou la description d'une compétence d'un cas particulier Browser/Transcription.

1. Préparer une image dédiée et son Dockerfile, son healthcheck et sa CI de compilation, scan de vulnérabilités et test fonctionnel hors ligne. Choisir des limites CPU/RAM, un utilisateur non privilégié, un réseau minimal et une politique de stockage. Documenter ce qui est conservé après désinstallation.
2. Ajouter une entrée au catalogue : `schemaVersion: 1`, identifiant stable, version sémantique, identifiant de pilote, titres et descriptions FR/EN, dépôt d'image approuvé, ressources, politique d'isolation versionnée et chemin du guide. `defaultInstalled` doit rester `false`. Le catalogue refuse les identifiants invalides, doublons, défauts activés ou pilotes incomplets.
3. Implémenter le **pilote interne revu** et l'enregistrer côté Manager. Il fournit les fonctions suivantes ; elles sont du code serveur de confiance, jamais des commandes provenant d'un manifeste téléchargé :

| Fonction                    | Contrat                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect()`                 | Retourne le conteneur appartenant à cette stack, ou `null`. Vérifie nom, labels, image, utilisateur, réseaux, montages et isolation ; refuse un conteneur étranger. |
| `status()`                  | Retourne `state` et `activeLeases`, sans secret. Une panne ne doit pas être présentée comme une absence.                                                            |
| `install(inventory)`        | Prépare uniquement les ressources approuvées, avec téléchargement du dépôt fixe et contrôle réel du résultat. Aucun paramètre Docker libre venant de l'interface.   |
| `configure(installed)`      | Rend le service disponible ou indisponible aux routes applicatives et, si nécessaire, à son inventaire optionnel. Ne change pas les permissions des agents.         |
| `prune()`                   | Expire les baux arrivés à échéance.                                                                                                                                 |
| `busy()` / `activeLeases()` | Empêchent une désinstallation pendant une préparation ou une utilisation.                                                                                           |
| `legacyEnabled()`           | Reconnaît une ancienne activation explicite lors de la première migration uniquement. Retourne `false` pour une compétence entièrement nouvelle.                    |

4. Brancher les routes fonctionnelles sur le pilote et ses baux. Elles doivent refuser une compétence absente et les mutations concurrentes ; masquer un bouton ne suffit pas. Ne jamais exposer les secrets du transport dans le catalogue, les journaux publics ou les réponses à l'interface. Adapter les outils MCP éventuels et leur disponibilité sans ajouter de droits.
5. Intégrer les services installés au plan de mise à jour et à l'inventaire **optionnel**, avec la vérification de compatibilité et de santé correspondante. Les trois composants du socle ne doivent pas être déplacés ou réadoptés implicitement. Une nouvelle topologie ou une intégration au registre d'adoption nécessite sa propre revue et ses tests.
6. Ajouter des tests : installation neuve sans conteneur, ajout du catalogue à une installation existante sans installation automatique, migration, redémarrage, confirmation, refus non administrateur, bail actif, identité Docker modifiée, panne de téléchargement, suppression sans volumes et retour des interfaces après installation/désinstallation. Tester l'image réelle en CI dans son sandbox avant publication.
7. Ajouter le guide utilisateur et technique dans `docs/`, le référencer dans le catalogue et l'index, puis ouvrir une PR. Après validation, publier les images du canal et vérifier sur une stack de test.

Le gestionnaire commun assure la validation de la demande, la confirmation, l'exclusion des opérations, la persistance atomique, l'état d'avancement et la suppression du conteneur vérifié. Les ressources annoncées dans le catalogue sont descriptives : **le pilote doit les imposer dans sa spécification Docker et les vérifier**. Une entrée de catalogue seule n'autorise pas l'exécution d'une image.

### Vers une marketplace

Cette version est un **catalogue embarqué et revu**, pas une marketplace permettant d'installer du code tiers. Un contributeur peut proposer une compétence avec une PR suivant cette procédure ; ajouter une entrée ne nécessite pas de créer un nouvel écran d'installation.

Une future marketplace devra ajouter une chaîne de signature et de provenance, un registre de confiance, une compatibilité versionnée avec Mergeron, une résolution des dépendances, des permissions explicitement acceptées, des migrations de données et un mécanisme de révocation. Les extensions distantes ne devront jamais fournir de commandes hôte, de chemins de montage arbitraires ou de socket Docker. Le contrat du catalogue prépare cette évolution sans activer aujourd'hui de chargement de pilotes externes.
