# Correspondance des personnes à l’import

Après l’analyse du ZIP, l’administrateur choisit une correspondance pour chaque
personne source. Le nom, la référence et l’adresse e-mail permettent de distinguer
les homonymes. Aucune correspondance n’est appliquée automatiquement.

- **Personne existante** : les références du projet importé (participants,
  groupes, responsable, tâches, auteurs des versions et historiques) utilisent
  cette personne. Son profil, ses identifiants de connexion et ses droits ne sont
  jamais remplacés par ceux de l’archive.
- **Nouvelle personne** : un contact standard inactif est créé, sans identité de
  connexion ni adresse e-mail unique importée. Les coordonnées d’origine restent
  dans la provenance, comme dans les imports précédents.

Plusieurs personnes source peuvent être associées à une seule personne cible.
Les adhésions aux participants et aux groupes sont alors dédupliquées. Le choix
reste obligatoire même si les noms ou les adresses e-mail sont identiques.

Le serveur refuse les choix incomplets, les personnes source inconnues et les
cibles inexistantes. Les cibles sont revérifiées lors de la transaction finale.
La provenance conserve les correspondances choisies ; un échec ne modifie pas
les comptes existants. Les archives anciennes restent compatibles, mais les
clients d’import doivent transmettre `personMappings`, une correspondance de
chaque identifiant source vers un identifiant existant ou `null` pour créer.
