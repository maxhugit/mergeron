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

## Protection Linux

`MERGERON_PUBLISHED_DOCUMENT_PROTECTION=required` impose une frontière de montage
externe à Codex. Elle ne peut pas être levée par son mode accès complet ou une
approbation de commande. Les dossiers `livrables` et `.mergeron` sont en lecture
seule pour ses descendants. Mergeron reste leur écrivain côté application.

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
