# Mises à jour individuelles des conteneurs

Dans **Serveur → Mise à jour**, chaque composant géré (application, ingress
NGINX, sortie Squid, navigateur lorsqu’il est activé) affiche l’image installée,
le canal suivi, l’empreinte publiée et son état. Le bouton de chaque carte prépare
une mise à jour **de cette image uniquement**. Le plan affiche le composant et
l’empreinte exacte avant confirmation. Aucun téléchargement ni installation
n’est déclenché par la détection.

La transaction applique la [politique de sauvegarde de l’environnement](sauvegarde-restauration.md#politique-des-mises-à-jour-du-manager) :
aucune sauvegarde en Dev, données essentielles seulement en production.
Les contrôles de santé restent obligatoires. Les autres images ne sont pas mises
à niveau implicitement, mais **la stack entière est arrêtée et recréée**. Le
retour arrière Dev ne remet que les images, pas les données ou migrations.
Ce n’est donc pas un redémarrage à chaud sans
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
`GET /distribution/{name}/json` de Docker. Une empreinte de catalogue identique
peut confirmer l’état courant, mais une différence seule n’est pas une mise à
jour : une autre architecture ou une attestation peut avoir changé. Le Manager
fournit l’identité de configuration installée et sa plateforme. Le backend lit
ensuite les manifestes du **digest immuable détecté**, sélectionne sans ambiguïté
l’OS/architecture/variante et compare l’identité de configuration de cette
plateforme à celle de l’image installée. Les SHA-256 des manifestes sont vérifiés.
Une vraie reconstruction reste détectée même si le numéro de version est identique.

Le backend expose ce résultat par l’API d’administration
`GET /api/settings/manager/image-updates`. Le socket Docker n’est jamais exposé
au navigateur et aucun identifiant de registre n’est retourné.

Le Manager garde `--network none` : la lecture des métadonnées publiques passe
par le backend et son proxy filtré, sans couches d’image, blob de configuration,
helper Docker ni commande dans un conteneur. Seuls les dépôts officiels des quatre
composants sont admis, avec délais/tailles bornés et sans redirection HTTP. Un
ancien Manager qui ne fournit pas l’identité de plateforme, un proxy bloquant
les métadonnées ou une variante ambiguë donnent un état **inconnu**, sans bouton
de mise à jour sur une simple différence de catalogue. Mettre à jour ensemble
le Manager et l’application pour activer la comparaison complète.

Les nouvelles installations Squid autorisent précisément `auth.docker.io` et
`registry-1.docker.io`, en plus de GHCR et GitHub. Sur une configuration persistante
existante, l’opérateur doit ajouter ces deux hôtes à `allowed_domains`, puis
valider et recharger Squid. Ne pas ouvrir `.docker.io` en entier ni modifier les
refus des réseaux privés/TLS. Cette PR n’effectue aucune migration réseau implicite.

## Améliorations disponibles et installées

**Mise à jour** conserve les notes stables ou la comparaison des révisions qui
restent à installer. **Version actuelle → Améliorations déjà installées** lit
le dernier commit de la révision embarquée dans l’image, avec son lien vers
l’historique. Ce résumé demeure accessible après une installation ou un
rafraîchissement ; ce n’est pas le journal exhaustif d’une transaction passée.
La route administrée `GET /api/settings/release/installed-changes` ne prend pas
de révision fournie par le client et vérifie le SHA retourné par GitHub. Une
indisponibilité des notes ne change jamais la détection des images. Pour les
images tierces, les liens éditeur restent explicitement distincts d’un résumé
des différences : aucun historique de sécurité ou d’améliorations n’est inventé.

L’interface prépare le plan existant avec
`images: { [componentId]: "repository@sha256:…" }`, puis transmet le fingerprint
vérifié et la confirmation du plan : `UPDATE_WITHOUT_DATA_BACKUP` en Dev,
`UPDATE_WITH_ROLLBACK` en production. Une modification d’état entre
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
