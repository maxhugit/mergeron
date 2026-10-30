# Mises à jour individuelles des conteneurs

Dans **Serveur → Mise à jour**, chaque composant géré (application, ingress
NGINX, sortie Squid, navigateur lorsqu’il est activé) affiche l’image installée,
le canal suivi, l’empreinte publiée et son état. Le bouton de chaque carte prépare
une mise à jour **de cette image uniquement**. Le plan affiche le composant et
l’empreinte exacte avant confirmation. Aucun téléchargement ni installation
n’est déclenché par la détection.

La transaction conserve les sauvegardes, contrôles de santé et restauration
existants. Les autres images ne sont pas mises à niveau implicitement, mais
**la stack entière est arrêtée et recréée** pour garantir une sauvegarde cohérente
et un retour arrière complet. Ce n’est donc pas un redémarrage à chaud sans
interruption. Aucun choix ne contourne les blocages du Manager.

Les résultats terminés se consultent avec **Voir le suivi et les logs** : le
panneau permanent de réussite est retiré. Les erreurs et récupérations nécessaires
restent visibles.

## Sources et limites

- Application : `ghcr.io/maxhugit/mergeron`, canal configuré ou edge en dev,
  latest en production. Les notes de version et commits restent affichés par la
  détection existante de l’application.
- Ingress : dépôt officiel `nginx`, tag configuré (par défaut stable).
- Sortie : `ubuntu/squid`, tag configuré (par défaut latest).
- Navigateur : `ghcr.io/maxhugit/mergeron-browser`, edge en dev, latest pour une
  version publiée. La gestion en production est disponible à partir du Manager
  0.5.1, par activation explicite ; voir le [déploiement du navigateur](navigateur-annote.md#gestion-par-le-manager).

Pour NGINX, Squid et le navigateur, des liens vers les informations de l’éditeur
sont fournis. Un changement d’empreinte peut être une reconstruction ou une
correction de sécurité : le registre ne fournit pas à lui seul un résumé fiable
des améliorations entre deux images. L’interface le signale plutôt que d’inventer
des notes de version. Les dépôts personnalisés ne sont pas interrogés.

Une erreur de registre, une architecture incompatible, une absence d’adoption ou
une empreinte installée inconnue ne sont jamais présentées comme « à jour ».
Les tags spécifiques de NGINX/Squid sont conservés lorsqu’ils sont encore connus
dans le conteneur ou dans la configuration d’installation du Manager. Après un
épinglage par digest, la configuration du Manager est la référence pour le canal.

Le navigateur historique de dev peut être une construction locale sans
`RepoDigests`. Dans ce cas, aucune comparaison de version n’est possible. Une
action explicite **Remplacer par l’image publiée** permet de migrer un navigateur
local connu de cette stack ; elle suit la même confirmation transactionnelle.
L’ancienne image locale est conservée pour le retour arrière.

## Technique

Le Manager expose en lecture seule `GET /v1/images/updates`, avec
`?refresh=true` pour ignorer le cache de cinq minutes. Les requêtes concurrentes
sont regroupées. Chaque composant échoue indépendamment. La découverte utilise
`GET /distribution/{name}/json` de Docker, et compare `Descriptor.digest` aux
`RepoDigests` locaux du même dépôt. La liste des plateformes doit comprendre
l’OS, l’architecture et la variante de l’image installée.

Le backend expose ce résultat par l’API d’administration
`GET /api/settings/manager/image-updates`. Le socket Docker n’est jamais exposé
au navigateur et aucun identifiant de registre n’est retourné.

L’interface prépare le plan existant avec
`images: { [componentId]: "repository@sha256:…" }`, puis transmet le fingerprint
vérifié et la confirmation `UPDATE_WITH_ROLLBACK`. Une modification d’état entre
préparation et application invalide le plan. La détection ne crée pas de nouvelle
voie d’exécution et ne modifie pas les règles d’autorisation du Manager.

Le workflow principal publie une image navigateur immuable puis ses tags publics
uniquement après validation des sources et analyse de vulnérabilités. Pour
bénéficier de cette fonctionnalité, mettre à jour **le Manager et l’application**.
Le Manager lui-même reste mis à jour par l’hôte ; il n’essaye pas de se remplacer
pendant sa propre transaction.

## Délais et résultat incertain

Les appels du backend au Manager pour préparer, appliquer ou récupérer une mise
à jour disposent d’un budget total de 30 secondes, distinct de la durée complète
de la transaction en arrière-plan. Les erreurs de transport sont structurées :
Manager indisponible (503), délai dépassé (504) ou réponse invalide (502), sans
exposer le message brut ou les secrets. Ce ne sont plus des erreurs 500 génériques.

Un délai dépassé après envoi ne prouve pas que l’opération a été refusée. Consulter
le suivi et l’état courant avant toute nouvelle demande ; aucune mutation n’est
automatiquement rejouée. La sauvegarde peut prendre bien plus longtemps que
30 secondes : son suivi par étapes n’est pas un chronomètre prévisionnel.
