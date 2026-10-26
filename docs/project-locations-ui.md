# Emplacements et connexions — première étape

Cette PR est uniquement une évolution de présentation. Elle distingue :

- l’**espace local géré**, emplacement principal permanent du projet ;
- les **dossiers locaux associés**, conservant leurs chemins actuels ;
- les **connexions externes**, configurées avec les protocoles déjà disponibles
  (Git, SSH/SFTP, FTP/FTPS).

L’ajout propose séparément un dossier local et une connexion externe. Les
informations générales comptent uniquement les emplacements locaux, sans les
présenter comme un total de connexions. Les paramètres du projet et le dialogue
de gestion réutilisent les actions existantes.

Dans l’explorateur contextualisé par un projet, l’entrée `.mergeron` située à la
racine de son emplacement principal est masquée par défaut. Un administrateur
peut la réafficher explicitement en vue technique, sans changement des droits
serveur. `.git`, `.env`, les autres fichiers cachés et les dossiers homonymes
dans les emplacements secondaires ne sont pas masqués. La navigation explicite
dans une copie de travail reste inchangée.

Ce masquage concerne la liste des fichiers du projet : ce n’est ni une nouvelle
règle d’autorisation ni une interdiction d’accès par chemin. Les protections
existantes continuent de s’appliquer. Les explorateurs globaux et sélecteurs de
dossiers sans contexte projet ne sont pas modifiés.

Aucune migration, aucun déplacement, aucune nouvelle autorisation et aucune
modification de secret ne sont nécessaires. Les noms de champs, identifiants,
routes API et identifiants d’onglet `workspaces` restent compatibles. La
séparation du modèle de données, l’évolution des droits et l’adaptation des
transferts/imports relèvent des PR suivantes.
