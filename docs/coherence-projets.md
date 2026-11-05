# Cohérence des projets

[← Documentation](README.md) · [Organisation de l’explorateur](explorateur-projet.md)

## Utilisation

Dans les paramètres globaux, ouvrir **Cohérence des projets**, puis choisir un
projet. Le diagnostic compare les références en base avec l’organisation physique
attendue. **Actualiser le diagnostic** relance la lecture sans modifier de données.
La page et ses API sont réservées aux administrateurs actifs.

Le rapport montre les chemins concernés et distingue les erreurs des avertissements :

- identité, emplacement principal et version d’organisation du projet ;
- dossiers attendus, collisions de chemins et liens symboliques ;
- documents courants, numéro de version et existence des fichiers historiques ;
- copies Git enregistrées, emplacement et présence des métadonnées Git ;
- dossiers de référence des agents, chemins mémorisés et sélections actives ;
- fichiers ou dossiers présents dans les projections de livrables et les copies
  de sources mais non enregistrés en base.

L’absence d’anomalie ne prouve pas l’intégrité du contenu binaire ni la présence
de tous les anciens fichiers libres : aucun inventaire historique de ces fichiers
n’est disponible. Créer un dossier vide ne restaure pas ses anciens fichiers.

Les fichiers libres de `dossiers/`, y compris les dossiers cachés, ne sont pas
considérés comme des anomalies. Les connexions secondaires externes ne sont pas
parcourues. Le diagnostic ne lit pas les contenus documentaires, ne calcule pas
leurs empreintes et ne remplace pas une validation documentaire ou `git fsck`.
Les anciennes organisations et les emplacements non canoniques sont signalés
pour traitement manuel, sans migration implicite.

## Corrections

Une action est proposée seulement lorsqu’une correction ciblée peut être vérifiée :

- **Recréer ce dossier vide** : dossier attendu manquant, avec parent existant et
  identité du projet vérifiée. Aucun contenu déclaré ne doit être reconstruit.
  Un historique contenant des versions et un livrable contenant des documents
  ne sont jamais remplacés par des dossiers vides. La création sûre utilise les
  descripteurs Linux et n’est pas proposée sur un serveur non Linux.
- **Réaligner cette référence** : ancien chemin d’un agent ou de sa conversation,
  dont la destination migrée est identifiée et existe. Les fichiers et les
  politiques de sécurité ne sont pas modifiés.

Chaque correction demande confirmation et concerne un seul élément. Un nouveau
contrôle serveur vérifie l’empreinte du diagnostic avant application ; si la base
ou les dossiers ont changé, la correction est refusée avec HTTP 409 et le rapport
est actualisé. Les corrections sont consignées dans le journal du projet avec
l’auteur, le chemin et l’action. Une nouvelle analyse suit chaque correction.

Pour les anomalies sans action automatique, une consigne est donnée : rechercher
ou restaurer le document, retrouver une copie Git et ses changements non publiés,
ou importer un fichier via la gestion documentaire du livrable. L’outil ne supprime
rien, n’adopte pas un fichier arbitraire en base et ne fait aucun clone, checkout,
reset ou changement de droits. Aucun bouton « tout corriger » n’est proposé.

## Technique

`ProjectIntegrityController` expose :

- `GET /api/project-integrity` : liste des projets ;
- `GET /api/project-integrity/:id` : rapport, compteurs, anomalies et empreinte ;
- `POST /api/project-integrity/:id/repair` : corps `fingerprint`, `issueId` et
  `confirmation: "REPAIR_PROJECT"`. Les chemins et les actions sont recalculés
  côté serveur ; le client ne fournit jamais un chemin à créer.

`ProjectIntegrityService` utilise les tables réelles et les alias de migration
existants. Les corrections partagent la sérialisation des migrations du projet.
Les mutations de références et leur journal sont transactionnels. La création
Linux traverse les parents avec `O_NOFOLLOW` et des descripteurs de répertoire,
puis crée seulement la dernière composante, sans écrasement ni `mkdir` récursif.

L’analyse ne suit pas les liens symboliques et est bornée : 10 000 sondes de
chemin, 5 000 entrées documentaires, profondeur 16, 1 000 entrées par niveau
administratif et 500 anomalies. Atteindre une limite produit un rapport incomplet
explicite et désactive ses corrections automatiques. Un échec de lecture ne doit
jamais être présenté comme un projet sain. Le résultat reste un instantané ; il
ne verrouille pas le travail des agents pendant la consultation.

Les tests couvrent l’autorisation, l’absence d’écriture pendant l’inspection,
les chemins non conformes et symboliques, les pertes documentaires, les références
obsolètes, les confirmations, le refus d’un diagnostic périmé et l’absence de
modification des politiques de sécurité. Les tests d’interface vérifient la
confirmation, l’annulation, le rafraîchissement et les erreurs de lecture.
