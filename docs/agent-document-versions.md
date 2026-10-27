# Enregistrer une nouvelle version

Cette opération enregistre un document dans un livrable. Ce n'est ni un nouveau
statut du cycle de vie, ni une publication Internet, ni une validation humaine.

## Fonctionnement

- Le code et les fichiers temporaires restent dans les dossiers de travail.
- Les documents à conserver sont préparés dans le dossier de brouillons indiqué
  à l'agent pour son tour courant.
- L'agent dépose une demande explicite et attend l'accusé d'enregistrement de
  Mergeron. Aucune clé administrative ne lui est transmise pour cette opération.
- Mergeron contrôle le projet lié à la conversation, le livrable, l'identité
  d'exécution et la version attendue. Il copie le brouillon depuis un descripteur
  vérifié, puis crée une version avec le nom de l'agent et le commentaire.
- Une demande périmée ou refusée conserve le brouillon et ne remplace pas la
  version courante. Un identifiant de demande n'est traité qu'une fois par tour.
- Sans gestionnaire de livrables, l'enregistrement est indisponible. Les fichiers
  hors de ce circuit restent des brouillons, pas des documents conservés.

Les noms techniques `publication-request.json` et `publication-result.json` sont
un protocole interne, utilisable aussi par les conversations existantes. L'agent
reçoit le format et les identifiants autorisés dans son contexte ; aucun nouvel
endpoint public ou secret d'administration n'est nécessaire.

## Rangement des fichiers et migration

Le fichier courant est conservé directement dans
`livrables/<id-livrable>/<nom-du-document>`, sans sous-dossier `published` ni
identifiant de document. L'explorateur affiche ce dossier sous le titre du livrable.
Les identifiants du livrable et du document restent stables en base ; ils ne sont
pas ajoutés au nom du fichier. Les versions restent séparées dans
`/workspaces/.mergeron-system/<id-projet>/history/deliverables/<id-livrable>/documents/<id-document>/<id-version>/`.
Cet espace système est distinct du dossier de travail et n'est consultable
directement que par les administrateurs. Les membres continuent de consulter
les versions via les fonctions du livrable et OnlyOffice, avec contrôle de leur
accès au projet, sans accès générique aux fichiers internes.

Au démarrage, les anciennes projections `published/<id-document>/fichier` sont
recopiées à la racine, contrôlées par empreinte SHA-256, puis leur référence est
mise à jour. L'ancien fichier n'est retiré qu'après cette validation et
l'enregistrement en base ; seuls ses dossiers devenus vides sont retirés.
Les anciens chemins sont conservés comme alias pour les liens existants et
OnlyOffice. Ces alias ne donnent aucun droit supplémentaire : les contrôles
d'accès s'appliquent aussi au chemin courant. Les lignes d'historique, les
instantanés, leurs empreintes et les numéros de version ne changent pas.

Une collision avec un autre document, un fichier de contenu différent, un lien
symbolique/physique ou un fichier manquant bloque uniquement ce déplacement.
Le fichier original et l'historique sont conservés et un avertissement
`root migration needs attention` identifie le document à réparer dans les logs.
Une destination identique permet de reprendre une copie interrompue sans
écrasement. Aucun fichier inconnu ni aucune sauvegarde de données n'est supprimé.

## Protection Linux

`MERGERON_PUBLISHED_DOCUMENT_PROTECTION=required` impose une frontière de montage
externe à Codex. Elle ne peut pas être levée par son mode accès complet ou une
approbation de commande. Le dossier `livrables` est en lecture seule pour ses
descendants ; l'espace système séparé est masqué. Mergeron reste leur écrivain
côté application. Les brouillons de publication sont préparés dans un espace
technique distinct, hors du dossier de travail et des historiques protégés.

Le runtime masque les clés et le socket du Manager, la base WebUI et ses fichiers
SQLite auxiliaires, ainsi que l'alias `/appdata` pouvant contenir les sauvegardes
de la pile. Les identifiants WebUI ne sont pas hérités dans l'environnement.
Les workspaces d'exécution doivent être des copies locales sous `/workspaces`.
Une nouvelle racine nécessite un redémarrage contrôlé de Codex, refusé si un
travail est actif ; aucun repli sans protection n'est effectué.

Un workspace ou un fichier conservé absent/inaccessible ne bloque plus le
démarrage de tous les projets. La frontière concernée est mise en quarantaine
en lecture seule ; les chemins absents sont masqués uniquement dans l'espace
isolé, sans recréation sur le serveur. Un tour visant un workspace mis en
quarantaine est refusé avec une demande de réparation. Les anomalies de sécurité
(liens symboliques, liens physiques multiples, chemins hors de `/workspaces`)
restent bloquantes : elles ne sont jamais ignorées.

La pile de développement active cette protection. Les installations existantes
de production ne sont pas activées implicitement. Les nouvelles installations
Compose/Manager déclarent la protection et le profil seccomp correspondant.
Il faut un noyau et un profil Docker permettant les espaces utilisateur ; ne pas
utiliser un conteneur privilégié ou ajouter des capacités pour contourner un refus.

Avant la première activation sur une pile existante, renouveler sa clé interne
backend/ingress si elle a pu être héritée par d'anciens agents. Cela invalide les
anciens jetons dérivés de cette clé et peut demander une reconnexion. Ne pas
réutiliser une clé de production dans la dev.

Les sources historiques hors du dossier du livrable sont copiées dans son dossier
protégé ; l'original est conservé et aucun numéro de version n'est modifié. Les
onglets Office ouverts sur l'ancien emplacement doivent être rouverts. L'ancien
endpoint de soumission de fichiers est refusé en mode protégé : enregistrer les
versions des documents, puis utiliser le circuit de validation du livrable.
