# Espaces de travail et système du projet

Les emplacements distinguent :

- l’**espace de travail**, emplacement principal permanent du projet ;
- l’**espace système**, séparé et réservé aux administrateurs ;
- les **dossiers locaux associés**, conservant leurs chemins actuels ;
- les **connexions externes**, configurées avec les protocoles déjà disponibles
  (Git, SSH/SFTP, FTP/FTPS).

L’ajout propose séparément un dossier local et une connexion externe. Les
informations générales comptent uniquement les emplacements locaux, sans les
présenter comme un total de connexions. Les paramètres du projet et le dialogue
de gestion réutilisent les actions existantes.

## Organisation v3

Le travail reste dans `/workspaces/<id-projet>`, avec `documents`, `sources`,
`livrables` et les instructions `AGENTS.md`. L'espace système se trouve dans
`/workspaces/.mergeron-system/<id-projet>` : marqueur d'appartenance,
connaissances internes, historiques et archives techniques.

L'explorateur système est proposé uniquement aux administrateurs, en consultation
seule. Il ne peut pas devenir le dossier de travail d'un agent. La restriction
est appliquée côté serveur, y compris aux chemins explicites, anciens liens,
liens symboliques et abonnements aux changements. Les API génériques de fichiers
ne peuvent pas modifier cet espace, même pour un administrateur. Les fonctions
applicatives restent les seuls écrivains autorisés. Les agents isolés ne voient
pas les données système ; les protections des livrables restent actives.

## Migration et liens existants

Au démarrage, les projets v1/v2 déplacent leur dossier interne `.webui` ou
`.mergeron` vers l'espace système, sur le même volume. Les fichiers de travail
gardent leur emplacement. Les anciens imports internes sont replacés dans
`sources/imported-workspaces` ou `documents/imported-attachments` ; leurs
références de dossiers, conversations et documents sont actualisées.
Les anciens brouillons et fichiers de préparation sont archivés, pas supprimés.

Les chemins enregistrés des historiques sont actualisés sans changer leurs
identifiants, numéros, empreintes ni contenu. Les anciens chemins sont résolus
par l'application vers leur destination, sans lien symbolique ouvrant l'espace
système. Les anciens liens de documents restent valides. L'accès aux versions
par le livrable et OnlyOffice reste contrôlé par les droits du projet ; cela ne
donne pas accès au reste de l'espace système.

Une ambiguïté d'appartenance, une collision de destination ou un répertoire
symbolique interrompt la migration sans fusion ni écrasement. Le déplacement
et la mise à jour transactionnelle des références peuvent être repris après
une interruption. Un espace absent n'est pas recréé silencieusement pour un
projet déjà migré.

## Export et import

Les archives v3 incluent l'espace système avec la capacité `system-spaces-v1`.
L'inventaire ne peut référencer que l'espace appartenant au projet. L'import
restaure d'abord une organisation intermédiaire v2 dans son répertoire de
préparation transactionnel, puis applique la migration v3 au seul projet importé.
Les contenus d'historique et les liens enregistrés restent inclus dans l'archive.
