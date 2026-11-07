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
